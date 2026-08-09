import type { OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';

import { DynamicCredentialEntryRepository } from '../../database/repositories/dynamic-credential-entry.repository';

/**
 * Persistence for resolvers that key credential data by an arbitrary external
 * subject. `data` is treated as opaque text: encryption happens above this
 * layer, so nothing here ever inspects or logs a payload.
 */
@Service()
export class DynamicCredentialEntryStorage {
	constructor(private readonly entryRepository: DynamicCredentialEntryRepository) {}

	async setCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		data: string,
		ctx: OperationContext,
	): Promise<void> {
		await this.entryRepository.upsertData({ credentialId, subjectId, resolverId }, data, ctx);
	}

	async getCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		ctx: OperationContext,
	): Promise<string | null> {
		return await this.entryRepository.findData({ credentialId, subjectId, resolverId }, ctx);
	}

	async deleteCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		ctx: OperationContext,
	): Promise<void> {
		await this.entryRepository.deleteByKey({ credentialId, subjectId, resolverId }, ctx);
	}

	/** Drops every subject's data for a resolver — used when a resolver is deleted. */
	async deleteAllCredentialData(input: {
		resolverId: string;
		resolverName: string;
		configuration: Record<string, unknown>;
	}): Promise<void> {
		await this.entryRepository.deleteByResolverId(input.resolverId, {});
	}
}
