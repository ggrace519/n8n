import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class AwsSecretsManagerProvider extends UnimplementedSecretsProvider {
	name = 'awsSecretsManager';

	displayName = 'AWS Secrets Manager';

	properties: INodeProperties[] = [
		{
			name: 'region',
			displayName: 'Region',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'us-east-1',
		},
		{
			name: 'accessKeyId',
			displayName: 'Access Key ID',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
		{
			name: 'secretAccessKey',
			displayName: 'Secret Access Key',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
		{
			name: 'sessionToken',
			displayName: 'Session Token',
			type: 'string',
			default: '',
			typeOptions: { password: true },
		},
	];
}
