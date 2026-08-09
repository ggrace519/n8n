import { Service } from '@n8n/di';

import type { SecretsProvider } from './types';

/**
 * The secret *names* each live provider currently publishes.
 *
 * Only names are cached: values are read straight from the live provider, so a
 * secret never has a second, longer-lived copy in this process. The cache is
 * refreshed synchronously after every successful `update()` and dropped when a
 * provider is disconnected or replaced, so a listing never outlives the
 * provider that produced it.
 */
@Service()
export class ExternalSecretsSecretsCache {
	private readonly secretNames = new Map<string, string[]>();

	refresh(providerKey: string, provider: SecretsProvider): void {
		try {
			this.secretNames.set(providerKey, provider.getSecretNames());
		} catch {
			// A provider that cannot list its secrets has none to offer.
			this.secretNames.set(providerKey, []);
		}
	}

	invalidate(providerKey: string): void {
		this.secretNames.delete(providerKey);
	}

	clear(): void {
		this.secretNames.clear();
	}

	getNames(providerKey: string): string[] {
		return this.secretNames.get(providerKey) ?? [];
	}

	has(providerKey: string): boolean {
		return this.secretNames.has(providerKey);
	}
}
