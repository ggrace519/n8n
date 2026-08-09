import type {
	ConnectionProjectSummary,
	CreateSecretsProviderConnectionDto,
	SecretProviderConnection,
	SecretsProviderState,
	TestSecretProviderConnectionResponse,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import type { SecretsProviderConnection, User } from '@n8n/db';
import {
	ProjectSecretsProviderAccessRepository,
	SecretsProviderConnectionRepository,
	TransactionRunner,
} from '@n8n/db';
import { Service } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EventService } from '@/events/event.service';

import { ExternalSecretsManager } from './external-secrets-manager';
import { ExternalSecretsProviderConnectionManager } from './external-secrets-provider-connection-manager';
import { ExternalSecretsProviders } from './external-secrets-providers';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import { ExternalSecretsSecretsCache } from './secrets-cache.service';
import { redactSettings } from './settings-redaction';

/**
 * The stored `type` is a free-form column: the public DTO enum constrains what
 * the API accepts, but the catalog stays runtime-extensible, so responses must
 * not promise the narrower union.
 */
export type SecretProviderConnectionResponse = Omit<SecretProviderConnection, 'type'> & {
	type: string;
};

export type SecretProviderConnectionListItemResponse = Omit<
	SecretProviderConnectionResponse,
	'settings' | 'secrets'
>;

/** Grants created through the project routes own their connection. */
const OWNER_ROLE = 'secretsProviderConnection:owner';
/** Grants created by sharing a global connection are use-only. */
const USER_ROLE = 'secretsProviderConnection:user';

@Service()
export class SecretProvidersConnectionsService {
	constructor(
		private readonly txRunner: TransactionRunner,
		private readonly connectionRepository: SecretsProviderConnectionRepository,
		private readonly projectAccessRepository: ProjectSecretsProviderAccessRepository,
		private readonly externalSecretsProviders: ExternalSecretsProviders,
		private readonly externalSecretsManager: ExternalSecretsManager,
		private readonly providerConnectionManager: ExternalSecretsProviderConnectionManager,
		private readonly providerRegistry: ExternalSecretsProviderRegistry,
		private readonly secretsCache: ExternalSecretsSecretsCache,
		private readonly eventService: EventService,
	) {}

	// #region reads

	async list(): Promise<SecretProviderConnectionListItemResponse[]> {
		const connections = await this.connectionRepository.find();
		return connections.map((connection) => this.toListItem(connection));
	}

	/** Everything the project may use: its own connections plus the global ones. */
	async listForProject(projectId: string): Promise<SecretProviderConnectionListItemResponse[]> {
		const connections = await this.connectionRepository.findAccessibleByProjectId(projectId);
		return connections.map((connection) => this.toListItem(connection));
	}

	async get(providerKey: string): Promise<SecretProviderConnectionResponse> {
		return this.toDetail(await this.findOrFail(providerKey));
	}

	/**
	 * @param mustOwn when set, a global connection is treated as absent — the
	 * project routes may read global connections but never mutate them.
	 */
	async getForProject(
		projectId: string,
		providerKey: string,
		{ mustOwn }: { mustOwn: boolean },
	): Promise<SecretProviderConnectionResponse> {
		return this.toDetail(await this.findForProjectOrFail(projectId, providerKey, { mustOwn }));
	}

	// #endregion

	// #region mutations

	/**
	 * @param projectId when set, the new connection belongs to that project alone
	 * and any `projectIds` in the payload is ignored.
	 */
	async create(
		user: User,
		dto: CreateSecretsProviderConnectionDto,
		{ projectId }: { projectId?: string } = {},
	): Promise<SecretProviderConnectionResponse> {
		const { providerKey, type, settings } = dto;

		const existing = await this.connectionRepository.findOneBy({ providerKey });
		if (existing !== null) {
			throw new BadRequestError(`Connection with key "${providerKey}" already exists`);
		}

		const projectIds = projectId === undefined ? dto.projectIds : [projectId];
		const role = projectId === undefined ? USER_ROLE : OWNER_ROLE;

		const connectionId = await this.txRunner.run({}, async (ctx) => {
			const created = await this.connectionRepository.createConnection(
				{
					providerKey,
					type,
					encryptedSettings: this.providerConnectionManager.encryptSettings(settings),
					isEnabled: true,
				},
				ctx,
			);
			await this.projectAccessRepository.createGrants(created.id, projectIds, role, ctx);
			return created.id;
		});

		const connection = await this.reloadRow(connectionId);
		await this.externalSecretsManager.activateConnection(connection);

		this.eventService.emit('external-secrets-connection-created', {
			userId: user.id,
			userRole: user.role?.slug,
			providerKey,
			vaultType: type,
			projects: this.projectSummaries(connection).map(({ id, name }) => ({ id, name })),
		});

		return this.toDetail(connection);
	}

	/**
	 * @param projectId when set, only a connection that project owns may be
	 * updated, and grants are left untouched.
	 */
	async update(
		user: User,
		providerKey: string,
		dto: UpdateSecretsProviderConnectionDto,
		{ projectId }: { projectId?: string } = {},
	): Promise<SecretProviderConnectionResponse> {
		const connection =
			projectId === undefined
				? await this.findOrFail(providerKey)
				: await this.findForProjectOrFail(projectId, providerKey, { mustOwn: true });

		await this.txRunner.run({}, async (ctx) => {
			await this.connectionRepository.updateById(
				connection.id,
				{
					...(dto.type === undefined ? {} : { type: dto.type }),
					...(dto.isEnabled === undefined ? {} : { isEnabled: dto.isEnabled }),
					// Settings replace wholesale: a merge would silently keep fields the
					// caller meant to drop.
					...(dto.settings === undefined
						? {}
						: {
								encryptedSettings: this.providerConnectionManager.encryptSettings(dto.settings),
							}),
				},
				ctx,
			);

			// Reassignment is a global-scope operation; from a project context the
			// connection stays where it is.
			if (projectId === undefined && dto.projectIds !== undefined) {
				await this.projectAccessRepository.deleteByConnectionId(connection.id, ctx);
				await this.projectAccessRepository.createGrants(
					connection.id,
					dto.projectIds,
					USER_ROLE,
					ctx,
				);
			}
		});

		const updated = await this.reloadRow(connection.id);

		if (updated.isEnabled) await this.externalSecretsManager.activateConnection(updated);
		else await this.externalSecretsManager.deactivateConnection(updated.providerKey);

		this.eventService.emit('external-secrets-connection-updated', {
			userId: user.id,
			userRole: user.role?.slug,
			providerKey: updated.providerKey,
			vaultType: updated.type,
			projects: this.projectSummaries(updated).map(({ id, name }) => ({ id, name })),
		});

		return this.toDetail(updated);
	}

	async delete(
		user: User,
		providerKey: string,
		{ projectId }: { projectId?: string } = {},
	): Promise<void> {
		const connection =
			projectId === undefined
				? await this.findOrFail(providerKey)
				: await this.findForProjectOrFail(projectId, providerKey, { mustOwn: true });

		const projects = this.projectSummaries(connection).map(({ id, name }) => ({ id, name }));

		// Grants go with it through the FK cascade.
		await this.connectionRepository.delete({ id: connection.id });
		await this.externalSecretsManager.deactivateConnection(providerKey);

		this.eventService.emit('external-secrets-connection-deleted', {
			userId: user.id,
			userRole: user.role?.slug,
			providerKey,
			vaultType: connection.type,
			projects,
		});
	}

	/** Re-read the store's secrets for one connection. */
	async reload(user: User, providerKey: string): Promise<{ success: boolean }> {
		const connection = await this.findOrFail(providerKey);
		const success = await this.externalSecretsManager.refreshConnection(connection);

		this.eventService.emit('external-secrets-connection-reloaded', {
			userId: user.id,
			userRole: user.role?.slug,
			providerKey,
			vaultType: connection.type,
			projects: this.projectSummaries(connection).map(({ id, name }) => ({ id, name })),
		});

		return { success };
	}

	/**
	 * A provider-level failure is a result, not a request error: the caller asked
	 * whether the connection works and gets a truthful answer with HTTP 200.
	 */
	async test(
		user: User,
		providerKey: string,
		{ projectId }: { projectId?: string } = {},
	): Promise<TestSecretProviderConnectionResponse> {
		const connection =
			projectId === undefined
				? await this.findOrFail(providerKey)
				: await this.findForProjectOrFail(projectId, providerKey, { mustOwn: true });

		const [success, error] = await this.externalSecretsManager.testConnection(connection);

		this.eventService.emit('external-secrets-connection-tested', {
			userId: user.id,
			userRole: user.role?.slug,
			providerKey,
			vaultType: connection.type,
			projects: this.projectSummaries(connection).map(({ id, name }) => ({ id, name })),
			isValid: success,
			errorMessage: error,
		});

		return {
			success,
			testState: success ? 'connected' : 'error',
			...(success ? {} : { error: error ?? 'Connection test failed' }),
		};
	}

	// #endregion

	// #region lookups

	private async findOrFail(providerKey: string): Promise<SecretsProviderConnection> {
		const connection = await this.connectionRepository.findByProviderKeyWithAccess(providerKey);
		if (connection === null) {
			throw new NotFoundError(`Connection with key "${providerKey}" not found`);
		}
		return connection;
	}

	private async findForProjectOrFail(
		projectId: string,
		providerKey: string,
		{ mustOwn }: { mustOwn: boolean },
	): Promise<SecretsProviderConnection> {
		const connection = await this.findOrFail(providerKey);
		const grants = connection.projectAccess ?? [];
		const belongsToProject = grants.some((grant) => grant.projectId === projectId);
		const isGlobal = grants.length === 0;

		if (belongsToProject || (isGlobal && !mustOwn)) return connection;

		// Deliberately the same message as a missing connection: a project must not
		// learn which keys exist elsewhere.
		throw new NotFoundError(`Connection with key "${providerKey}" not found`);
	}

	private async reloadRow(id: number): Promise<SecretsProviderConnection> {
		const connection = await this.connectionRepository.findOneBy({ id });
		if (connection === null) throw new NotFoundError('Connection not found');
		return connection;
	}

	// #endregion

	// #region response shaping

	private toListItem(
		connection: SecretsProviderConnection,
	): SecretProviderConnectionListItemResponse {
		return {
			id: String(connection.id),
			name: connection.providerKey,
			type: connection.type,
			state: this.stateOf(connection.providerKey),
			isEnabled: connection.isEnabled,
			projects: this.projectSummaries(connection),
			secretsCount: this.secretsCache.getNames(connection.providerKey).length,
			createdAt: connection.createdAt.toISOString(),
			updatedAt: connection.updatedAt.toISOString(),
		};
	}

	private toDetail(connection: SecretsProviderConnection): SecretProviderConnectionResponse {
		const secretNames = this.secretsCache.getNames(connection.providerKey);

		return {
			...this.toListItem(connection),
			settings: this.redactedSettings(connection),
			secrets: secretNames.map((name) => ({ name })),
		};
	}

	/** Never returns a stored password: password-typed fields come back blanked. */
	private redactedSettings(connection: SecretsProviderConnection): IDataObject {
		const settings = this.providerConnectionManager.decryptSettings(connection);
		return redactSettings(settings, this.propertiesOf(connection.type));
	}

	private propertiesOf(type: string) {
		const Provider = this.externalSecretsProviders.providers[type];
		return Provider === undefined ? [] : new Provider().properties;
	}

	private stateOf(providerKey: string): SecretsProviderState {
		// A connection with no live instance has not been started on this process.
		return this.providerRegistry.get(providerKey)?.state ?? 'initializing';
	}

	private projectSummaries(connection: SecretsProviderConnection): ConnectionProjectSummary[] {
		return (connection.projectAccess ?? []).map((grant) => ({
			id: grant.projectId,
			name: grant.project?.name ?? grant.projectId,
			role: grant.role,
		}));
	}

	// #endregion
}
