import { Service } from '@n8n/di';

import { SecretsProviderConnectionRepository } from '@n8n/db';

/**
 * Answers "may this project use this secrets provider?". A provider
 * connection with no project-access rows is global (available everywhere);
 * otherwise it is available only to the projects granted access.
 */
@Service()
export class SecretsProviderAccessCheckService {
	constructor(
		private readonly secretsProviderConnectionRepository: SecretsProviderConnectionRepository,
	) {}

	async isProviderAvailableInProject(providerKey: string, projectId: string): Promise<boolean> {
		const connection =
			await this.secretsProviderConnectionRepository.findByProviderKeyWithAccess(providerKey);
		if (!connection) return false;

		const grants = connection.projectAccess ?? [];
		if (grants.length === 0) return true;

		return grants.some((grant) => grant.projectId === projectId);
	}
}
