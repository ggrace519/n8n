import { DefaultAzureCredential } from '@azure/identity';
import {
	BlobServiceClient,
	StorageSharedKeyCredential,
	type BlockBlobClient,
	type ContainerClient,
} from '@azure/storage-blob';
import { Service } from '@n8n/di';
import { OperationalError, UserError } from 'n8n-workflow';
import { PassThrough, Readable, pipeline } from 'node:stream';

import { AzureBlobConfig } from './azure-blob.config';
import { createFixedSizeChunker } from '../stream-utils';
import type { BlobMetadata, PreWriteBlobMetadata } from '../types';

type BlobPutMetadata = PreWriteBlobMetadata & { fileSize?: number };

/**
 * Thin wrapper around the Azure Blob client, exposing the blob operations the
 * Azure-backed byte store needs. SDK failures are re-thrown as {@link OperationalError}
 * carrying the original SDK error on `cause`, so callers can inspect it (e.g. for
 * `BlobNotFound`) without depending on the SDK error type.
 */
@Service()
export class AzureBlobService {
	private client!: ContainerClient;

	private ready = false;

	constructor(private readonly config: AzureBlobConfig) {}

	async init() {
		this.client = this.createContainerClient();
		await this.checkConnection();
	}

	setReady(ready: boolean) {
		this.ready = ready;
	}

	async checkConnection() {
		if (this.ready) return;

		await this.run(async () => await this.client.createIfNotExists());

		this.setReady(true);
	}

	async put(key: string, body: Buffer, metadata: BlobPutMetadata = {}) {
		const blob = this.blobClient(key);

		await this.run(
			async () =>
				await blob.uploadData(body, {
					blobHTTPHeaders: metadata.mimeType ? { blobContentType: metadata.mimeType } : undefined,
					metadata: this.toNativeMetadata(metadata),
				}),
		);
	}

	async get(key: string, options: { mode: 'buffer' }): Promise<Buffer>;
	async get(key: string, options: { mode: 'stream'; chunkSize?: number }): Promise<Readable>;
	async get(
		key: string,
		options: { mode: 'buffer' } | { mode: 'stream'; chunkSize?: number },
	): Promise<Buffer | Readable> {
		const blob = this.blobClient(key);

		if (options.mode === 'buffer') {
			return await this.run(async () => await blob.downloadToBuffer());
		}

		// Tie the download to an abort signal so aborting the returned stream
		// releases the underlying socket instead of leaving it dangling.
		const abortController = new AbortController();
		const response = await this.run(
			async () => await blob.download(0, undefined, { abortSignal: abortController.signal }),
		);

		return this.bodyToStream(response.readableStreamBody, abortController, options.chunkSize);
	}

	async getMetadata(key: string): Promise<BlobMetadata> {
		const blob = this.blobClient(key);
		const props = await this.run(async () => await blob.getProperties());

		const filename = props.metadata?.filename;

		return {
			fileSize: props.contentLength ?? 0,
			mimeType: props.contentType,
			fileName: filename !== undefined ? decodeURIComponent(filename) : undefined,
		};
	}

	async delete(key: string) {
		const blob = this.blobClient(key);
		await this.run(async () => await blob.deleteIfExists());
	}

	// private methods

	private blobClient(key: string): BlockBlobClient {
		return this.client.getBlockBlobClient(key);
	}

	private createContainerClient(): ContainerClient {
		const { connectionString, accountName, accountKey, containerName, endpoint, authAutoDetect } =
			this.config;

		if (!containerName) {
			throw new UserError(
				'Azure Blob storage requires a container name (N8N_EXTERNAL_STORAGE_AZURE_CONTAINER_NAME).',
			);
		}

		const service = this.createServiceClient({
			connectionString,
			accountName,
			accountKey,
			endpoint,
			authAutoDetect,
		});

		return service.getContainerClient(containerName);
	}

	private createServiceClient(options: {
		connectionString: string;
		accountName: string;
		accountKey: string;
		endpoint: string;
		authAutoDetect: boolean;
	}): BlobServiceClient {
		const { connectionString, accountName, accountKey, endpoint, authAutoDetect } = options;

		// A connection string bundles endpoint and credentials, so it takes precedence.
		if (connectionString) {
			return BlobServiceClient.fromConnectionString(connectionString);
		}

		if (!accountName) {
			throw new UserError(
				'Azure Blob storage requires an account name or a connection string (N8N_EXTERNAL_STORAGE_AZURE_ACCOUNT_NAME).',
			);
		}

		const url = endpoint || `https://${accountName}.blob.core.windows.net`;

		// With auto-detect on, defer to the default credential chain (managed identity, env, CLI).
		if (authAutoDetect) {
			return new BlobServiceClient(url, new DefaultAzureCredential());
		}

		if (!accountKey) {
			throw new UserError(
				'Azure Blob storage requires an account key when auto-detect auth is disabled (N8N_EXTERNAL_STORAGE_AZURE_ACCOUNT_KEY).',
			);
		}

		return new BlobServiceClient(url, new StorageSharedKeyCredential(accountName, accountKey));
	}

	private toNativeMetadata(metadata: BlobPutMetadata): Record<string, string> | undefined {
		if (!metadata.fileName) return undefined;
		// Blob metadata may only contain US-ASCII, so encode non-ASCII filenames.
		return { filename: encodeURIComponent(metadata.fileName) };
	}

	private async run<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			throw new OperationalError('Request to Azure failed', { cause: error });
		}
	}

	private bodyToStream(
		body: NodeJS.ReadableStream | undefined,
		abortController: AbortController,
		chunkSize?: number,
	): Readable {
		if (!body) {
			throw new OperationalError('Azure blob download returned an empty body');
		}

		const output =
			chunkSize && chunkSize > 0 ? createFixedSizeChunker(chunkSize) : new PassThrough();

		output.once('close', () => abortController.abort());

		// `pipeline` (not `.pipe`) so upstream errors surface on `output` and a
		// destroyed `output` tears down the source.
		pipeline(body, output, () => {});

		return output;
	}
}
