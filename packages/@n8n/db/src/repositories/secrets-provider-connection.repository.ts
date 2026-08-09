import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

import { SecretsProviderConnection, SharedCredentials } from '../entities';

@Service()
export class SecretsProviderConnectionRepository extends Repository<SecretsProviderConnection> {
	constructor(dataSource: DataSource) {
		super(SecretsProviderConnection, dataSource.manager);
	}

	/** The connection's ID (as a string) for a provider key, or null. */
	async findIdByProviderKey(providerKey: string): Promise<string | null> {
		const connection = await this.findOne({ select: { id: true }, where: { providerKey } });
		return connection === null ? null : String(connection.id);
	}

	/** The connection IDs (as strings) for the given provider keys. */
	async findIdsByProviderKeys(providerKeys: string[]): Promise<string[]> {
		if (providerKeys.length === 0) return [];
		const connections = await this.find({
			select: { id: true },
			where: { providerKey: In(providerKeys) },
		});
		return connections.map((connection) => String(connection.id));
	}

	/** The connection with its project-access grants loaded, or null. */
	async findByProviderKeyWithAccess(
		providerKey: string,
	): Promise<SecretsProviderConnection | null> {
		return await this.findOne({
			where: { providerKey },
			relations: { projectAccess: true },
		});
	}

	/**
	 * Provider keys usable by a credential: providers with no project-access
	 * grants (global), plus providers granted to any project the credential is
	 * shared into.
	 */
	async findAllAccessibleProviderKeysByCredentialId(credentialId: string): Promise<string[]> {
		const [connections, sharings] = await Promise.all([
			this.find({ relations: { projectAccess: true } }),
			this.manager.find(SharedCredentials, {
				select: { projectId: true },
				where: { credentialsId: credentialId },
			}),
		]);

		const credentialProjectIds = new Set(sharings.map((sharing) => sharing.projectId));

		return connections
			.filter((connection) => {
				const grants = connection.projectAccess ?? [];
				if (grants.length === 0) return true;
				return grants.some((grant) => credentialProjectIds.has(grant.projectId));
			})
			.map((connection) => connection.providerKey);
	}
}
