import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { ExternalSecretsSecretsCache } from './secrets-cache.service';
import type { SecretsProvider, SecretsProviderSettings } from './types';

/**
 * Drives one provider through its lifecycle and keeps the secret-name cache in
 * step with it.
 *
 * Every step is failure-tolerant: one broken provider must not stop the others
 * from starting, so faults are recorded on the provider's `state` and logged
 * rather than thrown. Log lines carry the provider key and the error message
 * only — never settings or secret values.
 */
@Service()
export class ExternalSecretsProviderLifecycle {
	constructor(
		private readonly logger: Logger,
		private readonly secretsCache: ExternalSecretsSecretsCache,
	) {}

	/** @returns whether the provider is usable afterwards. */
	async init(
		providerKey: string,
		provider: SecretsProvider,
		settings: SecretsProviderSettings,
	): Promise<boolean> {
		try {
			await provider.init(settings);
			return true;
		} catch (error) {
			provider.state = 'error';
			provider.connectionError = this.reason(error);
			this.logger.error(
				`Failed to initialize external secrets provider "${providerKey}": ${provider.connectionError}`,
			);
			return false;
		}
	}

	/**
	 * Connect and immediately refresh, so a freshly connected provider can serve
	 * secrets without waiting for the polling interval.
	 *
	 * @returns whether the provider reached the connected state.
	 */
	async connect(providerKey: string, provider: SecretsProvider): Promise<boolean> {
		await provider.connect();

		if (provider.state !== 'connected') {
			this.logger.warn(
				`External secrets provider "${providerKey}" could not connect: ${provider.connectionError ?? 'unknown reason'}`,
			);
			this.secretsCache.invalidate(providerKey);
			return false;
		}

		await this.update(providerKey, provider);
		return true;
	}

	/** @returns whether the refresh succeeded. */
	async update(providerKey: string, provider: SecretsProvider): Promise<boolean> {
		try {
			await provider.update();
			this.secretsCache.refresh(providerKey, provider);
			return true;
		} catch (error) {
			this.logger.error(
				`Failed to update external secrets provider "${providerKey}": ${this.reason(error)}`,
			);
			return false;
		}
	}

	async disconnect(providerKey: string, provider: SecretsProvider): Promise<void> {
		this.secretsCache.invalidate(providerKey);
		try {
			await provider.disconnect();
		} catch (error) {
			this.logger.error(
				`Failed to disconnect external secrets provider "${providerKey}": ${this.reason(error)}`,
			);
		}
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
