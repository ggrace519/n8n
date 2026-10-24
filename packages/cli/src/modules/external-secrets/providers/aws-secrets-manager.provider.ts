// Clean-room implementation. Sources: the fair-code SecretsProvider contract
// (../types.ts), this repo's E2E specs for the settings shape, and the public
// AWS SDK for JavaScript v3 documentation for @aws-sdk/client-secrets-manager.
import {
	GetSecretValueCommand,
	ListSecretsCommand,
	SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import { parseSecretValue } from './secret-value';
import type { SecretsProviderSettings } from '../types';

type AwsAuthMethod = 'iamUser' | 'autoDetect';

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export class AwsSecretsManagerProvider extends SecretsProvider {
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
			name: 'authMethod',
			displayName: 'Authentication Method',
			type: 'options',
			default: 'iamUser',
			options: [
				{ name: 'IAM User (access key)', value: 'iamUser' },
				{ name: 'Auto Detect (default credential chain)', value: 'autoDetect' },
			],
		},
		{
			name: 'accessKeyId',
			displayName: 'Access Key ID',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			displayOptions: { show: { authMethod: ['iamUser'] } },
		},
		{
			name: 'secretAccessKey',
			displayName: 'Secret Access Key',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			displayOptions: { show: { authMethod: ['iamUser'] } },
		},
		{
			name: 'sessionToken',
			displayName: 'Session Token',
			type: 'string',
			default: '',
			typeOptions: { password: true },
			displayOptions: { show: { authMethod: ['iamUser'] } },
		},
	];

	private settings: IDataObject = {};

	private client: SecretsManagerClient | undefined;

	private cachedSecrets: Record<string, unknown> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings ?? {};
		this.client = undefined;
	}

	private buildClientConfig(): SecretsManagerClientConfig {
		const region = str(this.settings.region);
		if (!region) throw new UserError('AWS region is required');

		const authMethod: AwsAuthMethod =
			this.settings.authMethod === 'autoDetect' ? 'autoDetect' : 'iamUser';
		if (authMethod === 'autoDetect') return { region };

		const accessKeyId = str(this.settings.accessKeyId);
		const secretAccessKey = str(this.settings.secretAccessKey);
		if (!accessKeyId || !secretAccessKey) {
			throw new UserError('Access key ID and secret access key are required');
		}
		const sessionToken = str(this.settings.sessionToken);
		return {
			region,
			credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
		};
	}

	private getClient(): SecretsManagerClient {
		this.client ??= new SecretsManagerClient(this.buildClientConfig());
		return this.client;
	}

	/** SDK errors carry only AWS-side codes/messages, but we still never echo settings. */
	private describeError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const secrets = [
			this.settings.accessKeyId,
			this.settings.secretAccessKey,
			this.settings.sessionToken,
		];
		return secrets.reduce<string>(
			(msg, s) => (typeof s === 'string' && s.length > 0 ? msg.split(s).join('***') : msg),
			message,
		);
	}

	private async listSecretNames(): Promise<string[]> {
		const client = this.getClient();
		const names: string[] = [];
		let nextToken: string | undefined;
		do {
			const page = await client.send(new ListSecretsCommand({ NextToken: nextToken }));
			for (const entry of page.SecretList ?? []) {
				if (entry.Name && !entry.DeletedDate) names.push(entry.Name);
			}
			nextToken = page.NextToken;
		} while (nextToken);
		return names;
	}

	protected async doConnect(): Promise<void> {
		try {
			await this.getClient().send(new ListSecretsCommand({ MaxResults: 1 }));
		} catch (error) {
			throw new UserError(`Could not connect to AWS Secrets Manager: ${this.describeError(error)}`);
		}
	}

	async disconnect(): Promise<void> {
		this.client?.destroy();
		this.client = undefined;
	}

	async update(): Promise<void> {
		const client = this.getClient();
		const names = await this.listSecretNames();
		const next: Record<string, unknown> = {};
		for (const name of names) {
			const result = await client.send(new GetSecretValueCommand({ SecretId: name }));
			// Binary secrets have no expression-friendly form; skip them.
			if (typeof result.SecretString === 'string') {
				next[name] = parseSecretValue(result.SecretString);
			}
		}
		this.cachedSecrets = next;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.getClient().send(new ListSecretsCommand({ MaxResults: 1 }));
			return [true];
		} catch (error) {
			return [false, this.describeError(error)];
		}
	}

	getSecret(name: string): unknown {
		return this.cachedSecrets[name];
	}

	hasSecret(name: string): boolean {
		return Object.hasOwn(this.cachedSecrets, name);
	}

	getSecretNames(): string[] {
		return Object.keys(this.cachedSecrets);
	}
}
