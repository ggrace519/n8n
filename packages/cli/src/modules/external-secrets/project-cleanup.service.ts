import { Logger } from '@n8n/backend-common';
import {
	ProjectSecretsProviderAccessRepository,
	SecretsProviderConnectionRepository,
	TransactionRunner,
} from '@n8n/db';
import { Service } from '@n8n/di';

import type { ProjectOwnershipTransferHandler } from '@/services/ownership-transfer/ownership-transfer-handler.registry';

import { ExternalSecretsManager } from './external-secrets-manager';

/**
 * Cleans up secrets-provider connections when a project goes away.
 *
 * A project that *owns* a connection takes it with it; a project that was
 * merely granted access loses the grant, and the connection is disabled rather
 * than deleted so it stops reaching the store until someone re-scopes it. Both
 * halves plus the grant removal run in one transaction — a partial cleanup
 * would either strand a connection nobody can administer or leave grants
 * pointing at a deleted project.
 */
@Service()
export class ExternalSecretsProjectCleanup implements ProjectOwnershipTransferHandler {
	readonly resource = 'secrets provider connection';

	constructor(
		private readonly logger: Logger,
		private readonly txRunner: TransactionRunner,
		private readonly connectionRepository: SecretsProviderConnectionRepository,
		private readonly projectAccessRepository: ProjectSecretsProviderAccessRepository,
		private readonly externalSecretsManager: ExternalSecretsManager,
	) {}

	/**
	 * Connections are not transferred with a project: they are per-project
	 * configuration rather than user data, matching the `notTransferred`
	 * decision recorded for `ProjectSecretsProviderAccess` in the
	 * ownership-transfer manifest.
	 */
	async transferAll(
		_fromProjectId: string,
		_toProjectId: string,
		// Typed off the interface so this business-logic file stays free of TypeORM.
		_trx: Parameters<ProjectOwnershipTransferHandler['transferAll']>[2],
	): Promise<void> {}

	async deleteAll(projectId: string): Promise<void> {
		const affectedKeys = await this.txRunner.run({}, async (ctx) => {
			const grants = await this.projectAccessRepository.findByProjectId(projectId, ctx);
			if (grants.length === 0) return [];

			const connections = await this.connectionRepository.findByIds(
				grants.map((grant) => grant.secretsProviderConnectionId),
				ctx,
			);
			const keyById = new Map(connections.map((c) => [c.id, c.providerKey]));

			const ownedIds = grants
				.filter((grant) => grant.role === 'secretsProviderConnection:owner')
				.map((grant) => grant.secretsProviderConnectionId);
			const sharedIds = grants
				.filter((grant) => grant.role !== 'secretsProviderConnection:owner')
				.map((grant) => grant.secretsProviderConnectionId);

			await this.connectionRepository.deleteByIds(ownedIds, ctx);
			await this.connectionRepository.disableByIds(sharedIds, ctx);
			// Owned connections took their grants with them via the FK cascade;
			// this clears what the shared ones left behind.
			await this.projectAccessRepository.deleteByProjectId(projectId, ctx);

			return [...ownedIds, ...sharedIds]
				.map((id) => keyById.get(id))
				.filter((key): key is string => key !== undefined);
		});

		// Only once the rows are gone: a still-running provider would keep serving
		// secrets the project is no longer entitled to.
		for (const providerKey of affectedKeys) {
			try {
				await this.externalSecretsManager.deactivateConnection(providerKey);
			} catch (error) {
				this.logger.error(
					`Failed to stop external secrets provider "${providerKey}" after project deletion: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}
}
