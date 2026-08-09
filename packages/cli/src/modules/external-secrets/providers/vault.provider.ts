import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class VaultProvider extends UnimplementedSecretsProvider {
	name = 'vault';

	displayName = 'HashiCorp Vault';

	icon = 'vault';

	properties: INodeProperties[] = [
		{
			name: 'url',
			displayName: 'Vault URL',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://vault.example.com',
		},
		{
			name: 'token',
			displayName: 'Token',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
		{
			name: 'namespace',
			displayName: 'Namespace',
			type: 'string',
			default: '',
			required: false,
		},
	];
}
