import { SecretsProviderConnection } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

@Service()
export class SecretsProviderConnectionRepository extends Repository<SecretsProviderConnection> {
	constructor(dataSource: DataSource) {
		super(SecretsProviderConnection, dataSource.manager);
	}

	/** The connection with its project-access grants, or null. */
	async findByProviderKeyWithAccess(
		providerKey: string,
	): Promise<SecretsProviderConnection | null> {
		return await this.findOne({
			where: { providerKey },
			relations: { projectAccess: true },
		});
	}
}
