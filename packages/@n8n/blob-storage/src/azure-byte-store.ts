import { Service } from '@n8n/di';
import chunk from 'lodash/chunk';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { AzureBlobService } from './azure-blob/azure-blob.service';
import { assertChunkSize } from './stream-utils';
import type { BlobMetadata, ByteStore, ByteStoreKey, PreWriteBlobMetadata } from './types';

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** Caps concurrent delete requests, since Azure deletes one blob per request. */
const DELETE_BATCH_SIZE = 50;

/**
 * A {@link ByteStore} backed by Azure Blob storage. Azure deletes a single blob
 * per request, so bulk deletion is fanned out in bounded batches.
 */
@Service()
export class AzureByteStore implements ByteStore {
	constructor(private readonly azureBlob: AzureBlobService) {}

	async write(
		key: ByteStoreKey,
		body: Buffer | Readable,
		metadata?: PreWriteBlobMetadata,
	): Promise<number> {
		const bytes = Buffer.isBuffer(body) ? body : await buffer(body);
		await this.azureBlob.put(key, bytes, { mimeType: DEFAULT_MIME_TYPE, ...metadata });
		return bytes.length;
	}

	async read(key: ByteStoreKey): Promise<Buffer | null> {
		try {
			return await this.azureBlob.get(key, { mode: 'buffer' });
		} catch (error) {
			if (this.isMissing(error)) return null;
			throw error;
		}
	}

	async readStream(
		key: ByteStoreKey,
		{ chunkSize }: { chunkSize?: number } = {},
	): Promise<Readable | null> {
		if (chunkSize !== undefined) assertChunkSize(chunkSize);
		try {
			return await this.azureBlob.get(key, { mode: 'stream', chunkSize });
		} catch (error) {
			if (this.isMissing(error)) return null;
			throw error;
		}
	}

	async getMetadata(key: ByteStoreKey): Promise<BlobMetadata | null> {
		try {
			return await this.azureBlob.getMetadata(key);
		} catch (error) {
			if (this.isMissing(error)) return null;
			throw error;
		}
	}

	async copy(sourceKey: ByteStoreKey, targetKey: ByteStoreKey): Promise<void> {
		const bytes = await this.azureBlob.get(sourceKey, { mode: 'buffer' });
		const metadata = await this.azureBlob.getMetadata(sourceKey);
		await this.azureBlob.put(targetKey, bytes, metadata);
	}

	async rename(oldKey: ByteStoreKey, newKey: ByteStoreKey): Promise<void> {
		if (oldKey === newKey) return;
		await this.copy(oldKey, newKey);
		await this.azureBlob.delete(oldKey);
	}

	async delete(keys: ByteStoreKey[]): Promise<void> {
		for (const batch of chunk(keys, DELETE_BATCH_SIZE)) {
			await Promise.all(batch.map(async (key) => await this.azureBlob.delete(key)));
		}
	}

	// private methods

	/** A missing blob surfaces as a `BlobNotFound` error code. */
	private isMissing(error: unknown): boolean {
		return this.causeCode(error) === 'BlobNotFound';
	}

	private causeCode(error: unknown): string | undefined {
		const source = error instanceof Error && error.cause !== undefined ? error.cause : error;
		if (typeof source === 'object' && source !== null && 'code' in source) {
			const { code } = source;
			return typeof code === 'string' ? code : undefined;
		}
		return undefined;
	}
}
