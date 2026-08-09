import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class AzureKeyVaultProvider extends UnimplementedSecretsProvider {
	name = 'azureKeyVault';

	displayName = 'Azure Key Vault';

	/** No settings shape survives for this provider type; none is invented here. */
	properties: INodeProperties[] = [];
}
