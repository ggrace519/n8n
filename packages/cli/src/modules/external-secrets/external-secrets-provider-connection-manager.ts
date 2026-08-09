import { Logger } from '@n8n/backend-common';
import type { SecretsProviderConnection } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import type { IDataObject } from 'n8n-workflow';

import { ExternalSecretsProviders } from './external-secrets-providers';
import { ExternalSecretsProviderLifecycle } from './provider-lifecycle.service';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import type { SecretsProvider } from './types';

/**
 * Turns stored connection rows into live providers.
 *
 * Owns the decryption of `encryptedSettings` and the replacement rule: a key
 * already in the registry is disconnected before its successor takes the slot,
 * so an updated connection never leaves its predecessor holding an open session.
 */
@Service()
export class ExternalSecretsProviderConnectionManager {
	constructor(
		private readonly logger: Logger,
		private readonly externalSecretsProviders: ExternalSecretsProviders,
		private readonly providerRegistry: ExternalSecretsProviderRegistry,
		private readonly providerLifecycle: ExternalSecretsProviderLifecycle,
		private readonly cipher: Cipher,
	) {}

	/**
	 * Build, initialise, connect and register the provider for a connection row.
	 *
	 * @returns the live provider, or `undefined` when the row names a provider
	 * type this instance has no constructor for.
	 */
	async activate(connection: SecretsProviderConnection): Promise<SecretsProvider | undefined> {
		const { providerKey, type } = connection;

		const Provider = this.externalSecretsProviders.providers[type];
		if (Provider === undefined) {
			this.logger.warn(
				`External secrets connection "${providerKey}" names unknown provider type "${type}"`,
			);
			return undefined;
		}

		await this.deactivate(providerKey);

		const provider = new Provider();
		this.providerRegistry.set(providerKey, provider);

		const settings = this.decryptSettings(connection);
		const initialized = await this.providerLifecycle.init(providerKey, provider, {
			connected: connection.isEnabled,
			connectedAt: null,
			settings,
		});

		if (initialized) await this.providerLifecycle.connect(providerKey, provider);

		return provider;
	}

	/** Disconnect and forget the live provider behind a key, if there is one. */
	async deactivate(providerKey: string): Promise<void> {
		const existing = this.providerRegistry.delete(providerKey);
		if (existing) await this.providerLifecycle.disconnect(providerKey, existing);
	}

	/** The stored settings in the clear. Failure yields empty settings, never a throw. */
	decryptSettings(connection: SecretsProviderConnection): IDataObject {
		try {
			const decrypted = this.cipher.decrypt(connection.encryptedSettings);
			const parsed: unknown = JSON.parse(decrypted);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
			return parsed as IDataObject;
		} catch {
			// Never echo the ciphertext or the decrypted value into the log.
			this.logger.error(
				`Could not read settings of external secrets connection "${connection.providerKey}"`,
			);
			return {};
		}
	}

	encryptSettings(settings: IDataObject): string {
		return this.cipher.encrypt(settings);
	}
}
