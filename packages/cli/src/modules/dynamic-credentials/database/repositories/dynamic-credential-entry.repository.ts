import { BaseRepository, type OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { DynamicCredentialEntry } from '../entities/dynamic-credential-entry';

/** The full composite key identifying one generic entry. */
export type DynamicCredentialEntryKey = {
	credentialId: string;
	subjectId: string;
	resolverId: string;
};

@Service()
export class DynamicCredentialEntryRepository extends BaseRepository<DynamicCredentialEntry> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialEntry, dataSource.manager);
	}

	/** Inserts the entry, or replaces the `data` of the row with the same composite key. */
	async upsertData(key: DynamicCredentialEntryKey, data: string, ctx: OperationContext) {
		await this.managerFor(ctx).upsert(
			DynamicCredentialEntry,
			{ ...key, data, updatedAt: new Date() },
			{ conflictPaths: ['credentialId', 'subjectId', 'resolverId'] },
		);
	}

	async findData(key: DynamicCredentialEntryKey, ctx: OperationContext): Promise<string | null> {
		const entry = await this.managerFor(ctx).findOne(DynamicCredentialEntry, {
			where: key,
			select: ['data'],
		});
		return entry?.data ?? null;
	}

	async deleteByKey(key: DynamicCredentialEntryKey, ctx: OperationContext): Promise<void> {
		await this.managerFor(ctx).delete(DynamicCredentialEntry, key);
	}

	async deleteByResolverId(resolverId: string, ctx: OperationContext): Promise<void> {
		await this.managerFor(ctx).delete(DynamicCredentialEntry, { resolverId });
	}
}
