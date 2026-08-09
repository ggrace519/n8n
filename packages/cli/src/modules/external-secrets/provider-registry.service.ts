import { Service } from '@n8n/di';

import type { SecretsProvider } from './types';

/**
 * The live provider instances, keyed by the expression-facing `providerKey`
 * (`{{ $secrets.<providerKey>.<secret> }}`).
 *
 * A process-wide singleton so the expression proxy, the controllers and the
 * manager all observe the same instances.
 */
@Service()
export class ExternalSecretsProviderRegistry {
	private readonly instances = new Map<string, SecretsProvider>();

	get(providerKey: string): SecretsProvider | undefined {
		return this.instances.get(providerKey);
	}

	set(providerKey: string, provider: SecretsProvider): void {
		this.instances.set(providerKey, provider);
	}

	delete(providerKey: string): SecretsProvider | undefined {
		const provider = this.instances.get(providerKey);
		this.instances.delete(providerKey);
		return provider;
	}

	has(providerKey: string): boolean {
		return this.instances.has(providerKey);
	}

	keys(): string[] {
		return [...this.instances.keys()];
	}

	entries(): Array<[string, SecretsProvider]> {
		return [...this.instances.entries()];
	}

	clear(): void {
		this.instances.clear();
	}

	/**
	 * Detach every instance and return them. Lets teardown empty the shared
	 * registry synchronously and then disconnect the detached providers, so a
	 * concurrent re-initialisation cannot have its fresh instances removed by a
	 * still-running shutdown.
	 */
	takeAll(): Array<[string, SecretsProvider]> {
		const taken = this.entries();
		this.instances.clear();
		return taken;
	}
}
