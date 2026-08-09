import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import chunk from 'lodash/chunk';
import { OperationalError } from 'n8n-workflow';
import { createHash } from 'node:crypto';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { ObjectStoreConfig } from './object-store.config';
import type { MetadataResponseHeaders } from './types';
import { createFixedSizeChunker } from '../stream-utils';
import type { PreWriteBlobMetadata } from '../types';

/** A single object as returned by a `list`/`getListPage` call. */
export type ListItem = {
	key?: string;
	lastModified?: Date;
	eTag?: string;
	size?: number;
	storageClass?: string;
};

/** One page of a `ListObjectsV2` response. */
export type ListPage = {
	contents: ListItem[];
	isTruncated: boolean;
	nextContinuationToken?: string;
};

/** How many object keys a single S3 `DeleteObjects` request may carry. */
const MAX_KEYS_PER_DELETE = 1000;

/** How many per-key failures to name in a thrown delete error before truncating. */
const MAX_FAILURES_IN_MESSAGE = 3;

/**
 * Thin wrapper around the AWS S3 client, exposing the object operations the
 * S3-backed byte store needs. SDK failures are re-thrown as {@link OperationalError}
 * carrying the original SDK error on `cause`, so callers can inspect it (e.g. for
 * `NoSuchKey`) without depending on the SDK error type.
 */
@Service()
export class ObjectStoreService {
	private client!: S3Client;

	private ready = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: ObjectStoreConfig,
	) {}

	async init() {
		this.client = new S3Client(this.getClientConfig());
		await this.checkConnection();
	}

	setReady(ready: boolean) {
		this.ready = ready;
	}

	getClientConfig(): S3ClientConfig {
		const { host, protocol, bucket, credentials, forcePathStyle, maxAttempts } = this.config;

		const clientConfig: S3ClientConfig = {
			region: bucket.region,
			maxAttempts,
		};

		// An endpoint (and path-style addressing) is only meaningful for a custom
		// host; without one the SDK derives the endpoint from the region.
		if (host) {
			clientConfig.endpoint = `${protocol}://${host}`;
			clientConfig.forcePathStyle = forcePathStyle;
		}

		// With auto-detect on, defer to the SDK's default credential provider chain.
		if (!credentials.authAutoDetect) {
			clientConfig.credentials = {
				accessKeyId: credentials.accessKey,
				secretAccessKey: credentials.accessSecret,
			};
		}

		return clientConfig;
	}

	async checkConnection() {
		if (this.ready) return;

		await this.run(
			async () => await this.client.send(new HeadBucketCommand({ Bucket: this.bucketName })),
		);

		this.setReady(true);
	}

	async getMetadata(key: string): Promise<MetadataResponseHeaders> {
		const command = new HeadObjectCommand({ Bucket: this.bucketName, Key: key });
		const response = await this.run(async () => await this.client.send(command));

		const metadata: MetadataResponseHeaders = {};

		if (response.ContentLength !== undefined) {
			metadata['content-length'] = response.ContentLength.toString();
		}
		if (response.ContentType !== undefined) {
			metadata['content-type'] = response.ContentType;
		}
		const filename = response.Metadata?.filename;
		if (filename !== undefined) {
			metadata['x-amz-meta-filename'] = decodeURIComponent(filename);
		}

		return metadata;
	}

	async put(key: string, body: Buffer, metadata: PreWriteBlobMetadata = {}) {
		const s3Metadata: Record<string, string> = {};
		if (metadata.fileName) {
			// Object metadata may only contain US-ASCII, so encode non-ASCII filenames.
			s3Metadata.filename = encodeURIComponent(metadata.fileName);
		}

		const command = new PutObjectCommand({
			Bucket: this.bucketName,
			Key: key,
			Body: body,
			ContentLength: body.length,
			ContentMD5: createHash('md5').update(body).digest('base64'),
			ContentType: metadata.mimeType,
			Metadata: s3Metadata,
		});

		await this.run(async () => await this.client.send(command));
	}

	async get(key: string, options: { mode: 'buffer' }): Promise<Buffer>;
	async get(key: string, options: { mode: 'stream'; chunkSize?: number }): Promise<Readable>;
	async get(
		key: string,
		options: { mode: 'buffer' } | { mode: 'stream'; chunkSize?: number },
	): Promise<Buffer | Readable> {
		const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });

		if (options.mode === 'buffer') {
			const response = await this.run(async () => await this.client.send(command));
			return await this.bodyToBuffer(response.Body);
		}

		// Tie the download to an abort signal so aborting the returned stream
		// releases the underlying S3 socket instead of leaving it dangling.
		const abortController = new AbortController();
		const response = await this.run(
			async () => await this.client.send(command, { abortSignal: abortController.signal }),
		);

		return this.bodyToStream(response.Body, abortController, options.chunkSize);
	}

	async deleteOne(key: string) {
		const command = new DeleteObjectCommand({ Bucket: this.bucketName, Key: key });
		await this.run(async () => await this.client.send(command));
	}

	async deleteMany(prefix: string) {
		const items = await this.list(prefix);
		if (items.length === 0) return;

		const command = new DeleteObjectsCommand({
			Bucket: this.bucketName,
			Delete: { Objects: items.map((item) => ({ Key: item.key })) },
		});

		await this.run(async () => await this.client.send(command));
	}

	async deleteByKeys(keys: string[]) {
		if (keys.length === 0) return;

		const failures: Array<{ key?: string; code?: string; message?: string }> = [];

		for (const batch of chunk(keys, MAX_KEYS_PER_DELETE)) {
			const command = new DeleteObjectsCommand({
				Bucket: this.bucketName,
				Delete: { Objects: batch.map((key) => ({ Key: key })) },
			});

			const response = await this.run(async () => await this.client.send(command));

			if (response.Errors?.length) {
				failures.push(
					...response.Errors.map((error) => ({
						key: error.Key,
						code: error.Code,
						message: error.Message,
					})),
				);
			}
		}

		if (failures.length > 0) {
			this.logger.error('Failed to delete objects from S3', {
				bucket: this.bucketName,
				failures,
			});

			const named = failures
				.slice(0, MAX_FAILURES_IN_MESSAGE)
				.map((f) => `${f.key} (${f.code}: ${f.message})`)
				.join(', ');
			const suffix =
				failures.length > MAX_FAILURES_IN_MESSAGE
					? ` (and ${failures.length - MAX_FAILURES_IN_MESSAGE} more)`
					: '';

			throw new OperationalError(
				`Failed to delete ${failures.length} of ${keys.length} objects: ${named}${suffix}`,
			);
		}
	}

	async list(prefix: string): Promise<ListItem[]> {
		return await this.run(async () => {
			const items: ListItem[] = [];
			let continuationToken: string | undefined;

			do {
				const page = await this.getListPage(prefix, continuationToken);
				items.push(...page.contents);
				continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
			} while (continuationToken);

			return items;
		});
	}

	async getListPage(prefix: string, continuationToken?: string): Promise<ListPage> {
		const command = new ListObjectsV2Command({
			Bucket: this.bucketName,
			Prefix: prefix,
			...(continuationToken ? { ContinuationToken: continuationToken } : {}),
		});

		const response = await this.run(async () => await this.client.send(command));

		return {
			contents: (response.Contents ?? []).map((item) => ({
				key: item.Key,
				lastModified: item.LastModified,
				eTag: item.ETag,
				size: item.Size,
				storageClass: item.StorageClass,
			})),
			isTruncated: response.IsTruncated ?? false,
			nextContinuationToken: response.NextContinuationToken,
		};
	}

	// private methods

	private get bucketName() {
		return this.config.bucket.name;
	}

	private async run<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			throw new OperationalError('Request to S3 failed', { cause: error });
		}
	}

	private async bodyToBuffer(body: unknown): Promise<Buffer> {
		if (!(body instanceof Readable)) {
			throw new OperationalError('S3 response body is not a readable stream');
		}
		return await buffer(body);
	}

	private bodyToStream(
		body: unknown,
		abortController: AbortController,
		chunkSize?: number,
	): Readable {
		if (!(body instanceof Readable)) {
			throw new OperationalError('S3 response body is not a readable stream');
		}

		const output =
			chunkSize && chunkSize > 0 ? createFixedSizeChunker(chunkSize) : new PassThrough();

		// Aborting the S3 request when the consumer stops reading (destroy or early
		// close) prevents the underlying socket from lingering.
		output.once('close', () => abortController.abort());

		// `pipeline` (not `.pipe`) so upstream errors surface on `output` and a
		// destroyed `output` tears down the source.
		pipeline(body, output, () => {});

		return output;
	}
}
