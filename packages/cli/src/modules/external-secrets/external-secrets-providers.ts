import { Service } from '@n8n/di';

import { AwsSecretsManagerProvider } from './providers/aws-secrets-manager.provider';
import { AzureKeyVaultProvider } from './providers/azure-key-vault.provider';
import { GcpSecretsManagerProvider } from './providers/gcp-secrets-manager.provider';
import { InfisicalProvider } from './providers/infisical.provider';
import { OnePasswordProvider } from './providers/one-password.provider';
import { VaultProvider } from './providers/vault.provider';
import type { SecretsProviderConstructor } from './types';

/**
 * Catalog of provider *types*, keyed by the type identifier used in the API.
 *
 * Distinct from `ExternalSecretsProviderRegistry`, which holds the live
 * instances keyed by connection `providerKey` — one type can back several
 * connections with different expression names.
 *
 * The record is a plain instance property rather than a static so tests and
 * future extension points can substitute the catalog wholesale.
 */
@Service()
export class ExternalSecretsProviders {
	providers: Record<string, SecretsProviderConstructor> = {
		awsSecretsManager: AwsSecretsManagerProvider,
		gcpSecretsManager: GcpSecretsManagerProvider,
		vault: VaultProvider,
		azureKeyVault: AzureKeyVaultProvider,
		infisical: InfisicalProvider,
		onePassword: OnePasswordProvider,
	};
}
