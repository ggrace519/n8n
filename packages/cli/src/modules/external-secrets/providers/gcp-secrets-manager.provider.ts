import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class GcpSecretsManagerProvider extends UnimplementedSecretsProvider {
	name = 'gcpSecretsManager';

	displayName = 'Google Cloud Secret Manager';

	properties: INodeProperties[] = [
		{
			name: 'projectId',
			displayName: 'Project ID',
			type: 'string',
			default: '',
			required: true,
		},
	];
}
