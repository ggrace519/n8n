// Clean-room implementation built from the fair-code SecretsProvider contract
// (../types.ts) and the public @azure/keyvault-secrets and @azure/identity SDK docs.
import { ClientSecretCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { INodeProperties } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';

interface AzureKeyVaultSettings {
	vaultName: string;
	tenantId: string;
	clientId: string;
	clientSecret: string;
}

const VAULT_NAME_PATTERN = /^[a-zA-Z0-9-]{3,24}$/;

function readString(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}

export class AzureKeyVaultProvider extends SecretsProvider {
	name = 'azureKeyVault';

	displayName = 'Azure Key Vault';

	properties: INodeProperties[] = [
		{
			name: 'vaultName',
			displayName: 'Vault Name',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'my-key-vault',
		},
		{
			name: 'tenantId',
			displayName: 'Tenant ID',
			type: 'string',
			default: '',
			required: true,
		},
		{
			name: 'clientId',
			displayName: 'Client ID',
			type: 'string',
			default: '',
			required: true,
		},
		{
			name: 'clientSecret',
			displayName: 'Client Secret',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
	];

	private settings: AzureKeyVaultSettings = {
		vaultName: '',
		tenantId: '',
		clientId: '',
		clientSecret: '',
	};

	private client: SecretClient | undefined;

	private cachedSecrets: Record<string, string> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		const raw: Record<string, unknown> = settings.settings ?? {};
		this.settings = {
			vaultName: readString(raw, 'vaultName'),
			tenantId: readString(raw, 'tenantId'),
			clientId: readString(raw, 'clientId'),
			clientSecret: readString(raw, 'clientSecret'),
		};
		this.client = undefined;
	}

	private getClient(): SecretClient {
		if (this.client) return this.client;
		const { vaultName, tenantId, clientId, clientSecret } = this.settings;
		if (!vaultName || !tenantId || !clientId || !clientSecret) {
			throw new UserError('Azure Key Vault settings are incomplete');
		}
		if (!VAULT_NAME_PATTERN.test(vaultName)) {
			throw new UserError('Azure Key Vault name is invalid');
		}
		const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
		this.client = new SecretClient(`https://${vaultName}.vault.azure.net`, credential);
		return this.client;
	}

	protected async doConnect(): Promise<void> {
		const client = this.getClient();
		// Listing one page proves both the credential and the vault permissions.
		const iterator = client.listPropertiesOfSecrets().byPage({ maxPageSize: 1 });
		await iterator.next();
	}

	async disconnect(): Promise<void> {
		this.client = undefined;
	}

	async update(): Promise<void> {
		const client = this.getClient();
		const secrets: Record<string, string> = {};
		for await (const properties of client.listPropertiesOfSecrets()) {
			if (properties.enabled === false) continue;
			const secret = await client.getSecret(properties.name);
			if (typeof secret.value === 'string') secrets[properties.name] = secret.value;
		}
		this.cachedSecrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.doConnect();
			return [true];
		} catch (error) {
			return [false, errorMessage(error)];
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
