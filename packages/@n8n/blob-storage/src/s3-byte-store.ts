import { Service } from '@n8n/di';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { ObjectStoreService } from './object-store/object-store.service';
import type { MetadataResponseHeaders } from './object-store/types';
import { assertChunkSize } from './stream-utils';
import type { BlobMetadata, ByteStore, ByteStoreKey, PreWriteBlobMetadata } from './types';

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * A {@link ByteStore} backed by an S3-compatible object store. Bulk deletion is
 * delegated to {@link ObjectStoreService.deleteByKeys}; there is no `deletePrefix`
 * as prefix cleanup is handled by bucket lifecycle policies.
 */
@Service()
export class S3ByteStore implements ByteStore {
	constructor(private readonly objectStore: ObjectStoreService) {}

	async write(
		key: ByteStoreKey,
		body: Buffer | Readable,
		metadata?: PreWriteBlobMetadata,
	): Promise<number> {
		const bytes = Buffer.isBuffer(body) ? body : await buffer(body);
		await this.objectStore.put(key, bytes, { mimeType: DEFAULT_MIME_TYPE, ...metadata });
		return bytes.length;
	}

	async read(key: ByteStoreKey): Promise<Buffer | null> {
		try {
			return await this.objectStore.get(key, { mode: 'buffer' });
		} catch (error) {
			if (this.isMissingObject(error)) return null;
			throw error;
		}
	}

	async readStream(
		key: ByteStoreKey,
		{ chunkSize }: { chunkSize?: number } = {},
	): Promise<Readable | null> {
		if (chunkSize !== undefined) assertChunkSize(chunkSize);
		try {
			return await this.objectStore.get(key, { mode: 'stream', chunkSize });
		} catch (error) {
			if (this.isMissingObject(error)) return null;
			throw error;
		}
	}

	async getMetadata(key: ByteStoreKey): Promise<BlobMetadata | null> {
		try {
			return this.toBlobMetadata(await this.objectStore.getMetadata(key));
		} catch (error) {
			if (this.isMissingHead(error)) return null;
			throw error;
		}
	}

	async copy(sourceKey: ByteStoreKey, targetKey: ByteStoreKey): Promise<void> {
		const bytes = await this.objectStore.get(sourceKey, { mode: 'buffer' });
		const headers = await this.objectStore.getMetadata(sourceKey);
		await this.objectStore.put(targetKey, bytes, this.toPreWriteMetadata(headers));
	}

	async rename(oldKey: ByteStoreKey, newKey: ByteStoreKey): Promise<void> {
		if (oldKey === newKey) return;
		await this.copy(oldKey, newKey);
		await this.objectStore.deleteOne(oldKey);
	}

	async delete(keys: ByteStoreKey[]): Promise<void> {
		if (keys.length === 0) return;
		await this.objectStore.deleteByKeys(keys);
	}

	// private methods

	private toBlobMetadata(headers: MetadataResponseHeaders): BlobMetadata {
		return {
			fileSize: Number(headers['content-length']),
			mimeType: headers['content-type'],
			fileName: headers['x-amz-meta-filename'],
		};
	}

	private toPreWriteMetadata(headers: MetadataResponseHeaders): PreWriteBlobMetadata {
		return { mimeType: headers['content-type'], fileName: headers['x-amz-meta-filename'] };
	}

	/** A missing object surfaces as a `NoSuchKey` error, distinct from a `NoSuchBucket`. */
	private isMissingObject(error: unknown): boolean {
		return this.causeName(error) === 'NoSuchKey';
	}

	/** A HEAD on a missing object carries no error code, only a generic `NotFound` name. */
	private isMissingHead(error: unknown): boolean {
		return this.causeName(error) === 'NotFound';
	}

	private causeName(error: unknown): string | undefined {
		const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
		return source instanceof Error ? source.name : undefined;
	}
}
