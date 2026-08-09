import { BaseRepository, type OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, In, type EntityManager } from '@n8n/typeorm';

import { DynamicCredentialUserEntry } from '../entities/dynamic-credential-user-entry';

/** The full composite key identifying one per-user entry. */
export type DynamicCredentialUserEntryKey = {
	credentialId: string;
	userId: string;
	resolverId: string;
};

@Service()
export class DynamicCredentialUserEntryRepository extends BaseRepository<DynamicCredentialUserEntry> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialUserEntry, dataSource.manager);
	}

	/** Inserts the entry, or replaces the `data` of the row with the same composite key. */
	async upsertData(key: DynamicCredentialUserEntryKey, data: string, ctx: OperationContext) {
		await this.managerFor(ctx).upsert(
			DynamicCredentialUserEntry,
			{ ...key, data, updatedAt: new Date() },
			{ conflictPaths: ['credentialId', 'userId', 'resolverId'] },
		);
	}

	async findData(
		key: DynamicCredentialUserEntryKey,
		ctx: OperationContext,
	): Promise<string | null> {
		const entry = await this.managerFor(ctx).findOne(DynamicCredentialUserEntry, {
			where: key,
			select: ['data'],
		});
		return entry?.data ?? null;
	}

	async deleteByKey(key: DynamicCredentialUserEntryKey, ctx: OperationContext): Promise<void> {
		await this.managerFor(ctx).delete(DynamicCredentialUserEntry, key);
	}

	async deleteByResolverId(resolverId: string, ctx: OperationContext): Promise<void> {
		await this.managerFor(ctx).delete(DynamicCredentialUserEntry, { resolverId });
	}

	/**
	 * One bulk lookup of the credentials this user is connected to under a given
	 * resolver. Deliberately routed through `find` (rather than the entity
	 * manager) so callers and tests can observe a single query per request.
	 */
	async findConnectedCredentialIds(
		userId: string,
		credentialIds: string[],
		resolverId: string,
	): Promise<string[]> {
		const rows = await this.find({
			where: { userId, credentialId: In(credentialIds), resolverId },
			select: ['credentialId'],
		});
		return rows.map((row) => row.credentialId);
	}

	async countDistinctUsers(credentialId: string, resolverId: string): Promise<number> {
		const rows: Array<{ userId: string }> = await this.createQueryBuilder('entry')
			.select('DISTINCT entry.userId', 'userId')
			.where('entry.credentialId = :credentialId', { credentialId })
			.andWhere('entry.resolverId = :resolverId', { resolverId })
			.getRawMany();
		return rows.length;
	}

	/** Every credential these users hold an entry for, across all resolvers. */
	async findConnectedCredentialIdsForUsers(
		userIds: string[],
		em?: EntityManager,
	): Promise<string[]> {
		if (userIds.length === 0) return [];
		const manager = em ?? this.manager;
		const rows: Array<{ credentialId: string }> = await manager
			.createQueryBuilder(DynamicCredentialUserEntry, 'entry')
			.select('DISTINCT entry.credentialId', 'credentialId')
			.where('entry.userId IN (:...userIds)', { userIds })
			.getRawMany();
		return rows.map((row) => row.credentialId);
	}

	async deleteAllForCredential(credentialId: string, em?: EntityManager): Promise<void> {
		const manager = em ?? this.manager;
		await manager.delete(DynamicCredentialUserEntry, { credentialId });
	}

	/** Removes every entry these users hold, optionally scoped to one credential. */
	async deleteForUsers(
		userIds: string[],
		credentialId?: string,
		em?: EntityManager,
	): Promise<void> {
		if (userIds.length === 0) return;
		const manager = em ?? this.manager;
		await manager.delete(DynamicCredentialUserEntry, {
			userId: In(userIds),
			...(credentialId ? { credentialId } : {}),
		});
	}
}
