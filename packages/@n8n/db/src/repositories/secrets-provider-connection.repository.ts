import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { SecretsProviderConnection, SharedCredentials } from '../entities';
import type { OperationContext } from '../services/transaction';

/** Optional narrowing shared by the connection lookups used for completions. */
export type SecretsProviderConnectionFilter = { providerKeys?: string[] };

@Service()
export class SecretsProviderConnectionRepository extends BaseRepository<SecretsProviderConnection> {
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
	 * Enabled connections that no project owns — usable from anywhere.
	 * An explicitly empty `providerKeys` filter matches nothing.
	 */
	async findEnabledGlobalConnections(
		options: SecretsProviderConnectionFilter = {},
	): Promise<SecretsProviderConnection[]> {
		const connections = await this.findEnabledMatching(options);
		return connections.filter((connection) => (connection.projectAccess ?? []).length === 0);
	}

	/** Enabled connections granted to exactly this project; global rows are excluded. */
	async findEnabledByProjectId(
		projectId: string,
		options: SecretsProviderConnectionFilter = {},
	): Promise<SecretsProviderConnection[]> {
		const connections = await this.findEnabledMatching(options);
		return connections.filter((connection) =>
			(connection.projectAccess ?? []).some((grant) => grant.projectId === projectId),
		);
	}

	/** Connections a project may use: the ones granted to it, plus every global one. */
	async findAccessibleByProjectId(projectId: string): Promise<SecretsProviderConnection[]> {
		const connections = await this.find({ relations: { projectAccess: true } });
		return connections.filter((connection) => {
			const grants = connection.projectAccess ?? [];
			return grants.length === 0 || grants.some((grant) => grant.projectId === projectId);
		});
	}

	/** Every enabled connection, for provider start-up. */
	async findEnabled(): Promise<SecretsProviderConnection[]> {
		return await this.find({ where: { isEnabled: true }, relations: { projectAccess: true } });
	}

	async findByIds(ids: number[], ctx: OperationContext = {}): Promise<SecretsProviderConnection[]> {
		if (ids.length === 0) return [];
		return await this.managerFor(ctx).find(this.target, { where: { id: In(ids) } });
	}

	/** Insert a connection, returning the persisted row. */
	async createConnection(
		data: Pick<
			SecretsProviderConnection,
			'providerKey' | 'type' | 'encryptedSettings' | 'isEnabled'
		>,
		ctx: OperationContext = {},
	): Promise<SecretsProviderConnection> {
		const manager = this.managerFor(ctx);
		return await manager.save(manager.create(this.target, data));
	}

	/** Apply a partial change to one connection. */
	async updateById(
		id: number,
		data: Partial<Pick<SecretsProviderConnection, 'type' | 'encryptedSettings' | 'isEnabled'>>,
		ctx: OperationContext = {},
	): Promise<void> {
		await this.managerFor(ctx).update(this.target, { id }, data);
	}

	async deleteByIds(ids: number[], ctx: OperationContext = {}): Promise<void> {
		if (ids.length === 0) return;
		await this.managerFor(ctx).delete(this.target, { id: In(ids) });
	}

	async disableByIds(ids: number[], ctx: OperationContext = {}): Promise<void> {
		if (ids.length === 0) return;
		await this.managerFor(ctx).update(this.target, { id: In(ids) }, { isEnabled: false });
	}

	private async findEnabledMatching({
		providerKeys,
	}: SecretsProviderConnectionFilter): Promise<SecretsProviderConnection[]> {
		if (providerKeys !== undefined && providerKeys.length === 0) return [];

		return await this.find({
			where: {
				isEnabled: true,
				...(providerKeys === undefined ? {} : { providerKey: In(providerKeys) }),
			},
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
