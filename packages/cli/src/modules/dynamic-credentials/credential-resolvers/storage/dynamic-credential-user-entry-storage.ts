import type { OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';

import { DynamicCredentialUserEntryRepository } from '../../database/repositories/dynamic-credential-user-entry.repository';

/**
 * Persistence for resolvers that key credential data by n8n user. `data` is
 * treated as opaque text: encryption happens above this layer, so nothing here
 * ever inspects or logs a payload.
 */
@Service()
export class DynamicCredentialUserEntryStorage {
	constructor(private readonly userEntryRepository: DynamicCredentialUserEntryRepository) {}

	async setCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		data: string,
		ctx: OperationContext,
	): Promise<void> {
		await this.userEntryRepository.upsertData({ credentialId, userId, resolverId }, data, ctx);
	}

	async getCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		ctx: OperationContext,
	): Promise<string | null> {
		return await this.userEntryRepository.findData({ credentialId, userId, resolverId }, ctx);
	}

	async deleteCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		ctx: OperationContext,
	): Promise<void> {
		await this.userEntryRepository.deleteByKey({ credentialId, userId, resolverId }, ctx);
	}

	/** Drops every user's data for a resolver — used when a resolver is deleted. */
	async deleteAllCredentialData(input: {
		resolverId: string;
		resolverName: string;
		configuration: Record<string, unknown>;
	}): Promise<void> {
		await this.userEntryRepository.deleteByResolverId(input.resolverId, {});
	}
}
