import { Logger } from '@n8n/backend-common';
import type { SecretsProviderConnection } from '@n8n/db';
import { SecretsProviderConnectionRepository } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { Cipher, ExternalSecretsProxy } from 'n8n-core';
import type { IExternalSecretsManager } from 'n8n-core';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

import { EventService } from '@/events/event.service';

import { ExternalSecretsProviderConnectionManager } from './external-secrets-provider-connection-manager';
import { ExternalSecretsProviders } from './external-secrets-providers';
import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsProviderLifecycle } from './provider-lifecycle.service';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import { ExternalSecretsSecretsCache } from './secrets-cache.service';
import { redactSettings, restoreRedactedSettings } from './settings-redaction';
import { ExternalSecretsSettingsStore } from './settings-store.service';
import type {
	ExternalSecretsSettings,
	SecretsProvider,
	SecretsProviderSettings,
	SecretsProviderState,
} from './types';

/** One provider as the legacy `/external-secrets` routes describe it. */
export interface LegacyProviderSummary {
	name: string;
	displayName: string;
	icon: string;
	state: SecretsProviderState;
	connected: boolean;
	connectedAt: Date | string | null;
	data: IDataObject;
	properties?: INodeProperties[];
}

/**
 * Owns the running set of secrets providers.
 *
 * Two storage models feed it: the legacy single settings row (one provider per
 * type, keyed by type name) and the `secrets_provider_connection` entities (many
 * connections, keyed by `providerKey`). Whichever is active, the live instances
 * end up in one registry keyed by the name expressions use, and this manager is
 * what `ExternalSecretsProxy` resolves `$secrets` against.
 */
@Service()
export class ExternalSecretsManager implements IExternalSecretsManager {
	private pollTimer: NodeJS.Timeout | undefined;

	private polling = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: ExternalSecretsConfig,
		private readonly externalSecretsProviders: ExternalSecretsProviders,
		private readonly eventService: EventService,
		private readonly externalSecretsProxy: ExternalSecretsProxy,
		private readonly settingsStore: ExternalSecretsSettingsStore,
		private readonly providerRegistry: ExternalSecretsProviderRegistry,
		private readonly providerLifecycle: ExternalSecretsProviderLifecycle,
		private readonly providerConnectionManager: ExternalSecretsProviderConnectionManager,
		private readonly secretsCache: ExternalSecretsSecretsCache,
		private readonly secretsProviderConnectionRepository: SecretsProviderConnectionRepository,
		private readonly cipher: Cipher,
	) {}

	/**
	 * Connection rows replace the legacy settings row as soon as either
	 * multi-connection support or project scoping is switched on.
	 */
	get usesConnectionEntities(): boolean {
		return Boolean(
			this.config.externalSecretsForProjects || this.config.externalSecretsMultipleConnections,
		);
	}

	// #region lifecycle

	async init(): Promise<void> {
		// Nothing else registers the manager, and without it `$secrets` resolves
		// to no providers at all.
		this.externalSecretsProxy.setManager(this);

		await this.teardown();
		await this.loadProviders();
		this.startPolling();
	}

	/**
	 * Detach shared state synchronously, then disconnect the detached providers.
	 *
	 * Callers routinely fire this without awaiting and immediately re-initialise;
	 * clearing the registry up front means a slow disconnect can never evict the
	 * successor's freshly registered instances.
	 */
	async shutdown(): Promise<void> {
		this.stopPolling();
		const detached = this.providerRegistry.takeAll();
		this.secretsCache.clear();
		await this.disconnectAll(detached);
	}

	/** Drop every provider and rebuild them from storage. */
	@OnPubSubEvent('reload-external-secrets-providers')
	async reloadAllProviders(): Promise<void> {
		this.logger.debug('Reloading external secrets providers');
		await this.teardown();
		await this.loadProviders();
	}

	private async teardown(): Promise<void> {
		const detached = this.providerRegistry.takeAll();
		this.secretsCache.clear();
		await this.disconnectAll(detached);
	}

	private async disconnectAll(providers: Array<[string, SecretsProvider]>): Promise<void> {
		for (const [providerKey, provider] of providers) {
			await this.providerLifecycle.disconnect(providerKey, provider);
		}
	}

	private async loadProviders(): Promise<void> {
		if (this.usesConnectionEntities) await this.loadFromConnections();
		else await this.loadFromSettings();
	}

	/** Legacy model: every configured provider is initialised, only enabled ones connect. */
	private async loadFromSettings(): Promise<void> {
		const settings = await this.settingsStore.reload();
		if (settings === null) return;

		for (const [providerName, entry] of Object.entries(settings)) {
			const provider = this.instantiate(providerName, providerName);
			if (!provider) continue;

			const initialized = await this.providerLifecycle.init(providerName, provider, entry);
			if (initialized && entry.connected) {
				await this.providerLifecycle.connect(providerName, provider);
			}
		}
	}

	/** Entity model: every enabled row is initialised and connected. */
	private async loadFromConnections(): Promise<void> {
		const connections = await this.secretsProviderConnectionRepository.findEnabled();
		for (const connection of connections) {
			await this.providerConnectionManager.activate(connection);
		}
	}

	private instantiate(providerKey: string, type: string): SecretsProvider | undefined {
		const Provider = this.externalSecretsProviders.providers[type];
		if (Provider === undefined) {
			this.logger.warn(`Unknown external secrets provider type "${type}"`);
			return undefined;
		}

		const provider = new Provider();
		this.providerRegistry.set(providerKey, provider);
		return provider;
	}

	// #endregion

	// #region polling

	private startPolling(): void {
		this.stopPolling();

		const seconds = Number(this.config.updateInterval);
		if (!Number.isFinite(seconds) || seconds <= 0) return;

		this.pollTimer = setInterval(() => {
			this.pollOnce().catch(() => {});
		}, seconds * 1000);
		// Never keep the process alive just to refresh secrets.
		this.pollTimer.unref();
	}

	private stopPolling(): void {
		if (this.pollTimer === undefined) return;
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	/** Refresh every connected provider, one at a time, skipping overlapping runs. */
	private async pollOnce(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			for (const [providerKey, provider] of this.providerRegistry.entries()) {
				if (provider.state !== 'connected') continue;
				await this.providerLifecycle.update(providerKey, provider);
			}
		} finally {
			this.polling = false;
		}
	}

	// #endregion

	// #region IExternalSecretsManager

	getProvider(providerKey: string): SecretsProvider | undefined {
		return this.providerRegistry.get(providerKey);
	}

	hasProvider(providerKey: string): boolean {
		return this.providerRegistry.get(providerKey)?.state === 'connected';
	}

	getProviderNames(): string[] {
		return this.providerRegistry
			.entries()
			.filter(([, provider]) => provider.state === 'connected')
			.map(([providerKey]) => providerKey);
	}

	getSecretNames(providerKey: string): string[] {
		return this.secretsCache.getNames(providerKey);
	}

	hasSecret(providerKey: string, name: string): boolean {
		const provider = this.providerRegistry.get(providerKey);
		if (!provider || provider.state !== 'connected') return false;

		try {
			return provider.hasSecret(name);
		} catch {
			return this.secretsCache.getNames(providerKey).includes(name);
		}
	}

	getSecret(providerKey: string, name: string): unknown {
		const provider = this.providerRegistry.get(providerKey);
		if (!provider || provider.state !== 'connected') return undefined;

		try {
			return provider.getSecret(name);
		} catch {
			return undefined;
		}
	}

	/** Every connected provider's secret names, keyed by provider key. */
	getAllSecretNames(): Record<string, string[]> {
		return Object.fromEntries(
			this.getProviderNames().map((providerKey) => [
				providerKey,
				this.secretsCache.getNames(providerKey),
			]),
		);
	}

	// #endregion

	// #region connection-entity operations

	/** Bring a stored connection online (or replace the running one). */
	async activateConnection(connection: SecretsProviderConnection): Promise<void> {
		await this.providerConnectionManager.activate(connection);
	}

	/** Take a connection offline and forget its secrets. */
	async deactivateConnection(providerKey: string): Promise<void> {
		await this.providerConnectionManager.deactivate(providerKey);
	}

	/**
	 * Refresh one connection's secrets, starting it first if it is not running.
	 *
	 * @returns whether the refresh succeeded.
	 */
	async refreshConnection(connection: SecretsProviderConnection): Promise<boolean> {
		let provider = this.providerRegistry.get(connection.providerKey);
		if (!provider) provider = await this.providerConnectionManager.activate(connection);
		if (!provider) return false;

		if (provider.state !== 'connected') return false;

		return await this.providerLifecycle.update(connection.providerKey, provider);
	}

	/**
	 * Test a stored connection, starting it first if it is not running.
	 *
	 * @returns `[ok, reason?]`; a connection that never came up reports its
	 * connection error rather than the provider's own test result.
	 */
	async testConnection(connection: SecretsProviderConnection): Promise<[boolean, string?]> {
		let provider = this.providerRegistry.get(connection.providerKey);
		if (!provider) provider = await this.providerConnectionManager.activate(connection);
		if (!provider) return [false, `Unknown provider type "${connection.type}"`];

		if (provider.state !== 'connected') {
			return [false, provider.connectionError ?? 'Could not connect to the secrets provider'];
		}

		return await this.runProviderTest(provider);
	}

	// #endregion

	// #region legacy settings operations

	getLegacyProviderSummaries(includeProperties = false): LegacyProviderSummary[] {
		const settings = this.settingsStore.getCached() ?? {};
		return Object.keys(settings)
			.map((providerName) => this.buildLegacySummary(providerName, includeProperties))
			.filter((summary): summary is LegacyProviderSummary => summary !== undefined);
	}

	getLegacyProviderSummary(
		providerName: string,
		includeProperties = false,
	): LegacyProviderSummary | undefined {
		return this.buildLegacySummary(providerName, includeProperties);
	}

	private buildLegacySummary(
		providerName: string,
		includeProperties: boolean,
	): LegacyProviderSummary | undefined {
		const entry = this.settingsStore.getCached()?.[providerName];
		const provider = this.providerRegistry.get(providerName);
		if (entry === undefined || provider === undefined) return undefined;

		const summary: LegacyProviderSummary = {
			name: providerName,
			displayName: provider.displayName,
			icon: provider.icon ?? provider.name,
			state: provider.state,
			connected: entry.connected,
			connectedAt: entry.connectedAt,
			data: redactSettings(entry.settings, provider.properties),
		};

		if (includeProperties) summary.properties = provider.properties;

		return summary;
	}

	/**
	 * Replace a provider's settings and restart it. Password fields still
	 * carrying the blanking marker keep their stored value, so a client that
	 * round-trips a redacted response cannot wipe the credential.
	 */
	async setProviderSettings(providerName: string, data: IDataObject, userId?: string) {
		const settings = await this.currentSettings();
		const existingEntry = settings[providerName];
		const entry = existingEntry ?? this.emptyEntry();
		const properties = this.propertiesOf(providerName);

		settings[providerName] = {
			...entry,
			settings: restoreRedactedSettings(data, entry.settings, properties),
		};

		await this.settingsStore.save(settings);
		const isValid = await this.restartLegacyProvider(providerName);

		this.eventService.emit('external-secrets-provider-settings-saved', {
			userId,
			vaultType: providerName,
			isValid,
			isNew: existingEntry === undefined,
		});
	}

	/** Connect or disconnect a legacy provider without touching its settings. */
	async setProviderConnected(providerName: string, connected: boolean): Promise<boolean> {
		const settings = await this.currentSettings();
		const entry = settings[providerName] ?? this.emptyEntry();

		settings[providerName] = { ...entry, connected };
		await this.settingsStore.save(settings);

		return await this.restartLegacyProvider(providerName);
	}

	/** Try the given settings on a throwaway instance, leaving the live one alone. */
	async testProviderSettings(providerName: string, data: IDataObject): Promise<[boolean, string?]> {
		const Provider = this.externalSecretsProviders.providers[providerName];
		if (Provider === undefined) return [false, `Unknown provider "${providerName}"`];

		const stored = this.settingsStore.getCached()?.[providerName]?.settings ?? {};
		const candidate = new Provider();
		const settings = restoreRedactedSettings(data, stored, candidate.properties);

		try {
			await candidate.init({ connected: true, connectedAt: null, settings });
			await candidate.connect();
			if (candidate.state !== 'connected') {
				return [false, candidate.connectionError ?? 'Could not connect to the secrets provider'];
			}
			return await this.runProviderTest(candidate);
		} finally {
			// The throwaway instance may hold an open session even when the test failed.
			await candidate.disconnect().catch(() => {});
		}
	}

	/** Manual refresh of one running provider; refused while it is in error. */
	async updateProvider(providerName: string): Promise<boolean> {
		const provider = this.providerRegistry.get(providerName);
		if (!provider || provider.state !== 'connected') return false;

		const updated = await this.providerLifecycle.update(providerName, provider);
		if (updated) {
			this.eventService.emit('external-secrets-provider-reloaded', { vaultType: providerName });
		}

		return updated;
	}

	private async restartLegacyProvider(providerName: string): Promise<boolean> {
		const entry = this.settingsStore.getCached()?.[providerName];
		if (entry === undefined) return false;

		const existing = this.providerRegistry.delete(providerName);
		if (existing) await this.providerLifecycle.disconnect(providerName, existing);

		const provider = this.instantiate(providerName, providerName);
		if (!provider) return false;

		const initialized = await this.providerLifecycle.init(providerName, provider, entry);
		if (!initialized) return false;
		if (!entry.connected) return true;

		return await this.providerLifecycle.connect(providerName, provider);
	}

	private async currentSettings(): Promise<ExternalSecretsSettings> {
		return { ...((await this.settingsStore.reload()) ?? {}) };
	}

	private emptyEntry(): SecretsProviderSettings {
		return { connected: false, connectedAt: null, settings: {} };
	}

	private propertiesOf(providerName: string) {
		const Provider = this.externalSecretsProviders.providers[providerName];
		return Provider === undefined ? [] : new Provider().properties;
	}

	private async runProviderTest(provider: SecretsProvider): Promise<[boolean, string?]> {
		try {
			const [ok, reason] = await provider.test();
			return [ok, reason];
		} catch (error) {
			return [false, error instanceof Error ? error.message : String(error)];
		}
	}

	// #endregion

	/** Encrypt provider settings with the instance key, as stored on connection rows. */
	encryptSettings(settings: IDataObject): string {
		return this.cipher.encrypt(settings);
	}
}
