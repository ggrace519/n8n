// Clean-room implementation. Sources: this repo's fair-code SecretsProvider
// contract (../types.ts) and the public 1Password Connect SDK
// (`@1password/connect` type definitions: listVaults, listItems, getItemById).
import { OnePasswordConnect } from '@1password/connect';
import type { OPConnect } from '@1password/connect';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { OperationalError, UserError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';

type VaultSecrets = Record<string, Record<string, Record<string, string>>>;

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export class OnePasswordProvider extends SecretsProvider {
	name = 'onePassword';

	displayName = '1Password';

	properties: INodeProperties[] = [
		{
			name: 'serverUrl',
			displayName: 'Connect Server URL',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'http://localhost:8080',
		},
		{
			name: 'accessToken',
			displayName: 'Access Token',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
	];

	private serverUrl = '';

	private accessToken = '';

	private client?: OPConnect;

	private cachedSecrets: VaultSecrets = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		const s: IDataObject = settings.settings ?? {};
		this.serverUrl = str(s.serverUrl);
		this.accessToken = str(s.accessToken);
		this.client = undefined;
	}

	protected async doConnect(): Promise<void> {
		const client = this.createClient();
		await this.listVaults(client);
		this.client = client;
		await this.update();
	}

	async disconnect(): Promise<void> {
		this.client = undefined;
		this.cachedSecrets = {};
	}

	async update(): Promise<void> {
		const client = this.client ?? this.createClient();
		const secrets: VaultSecrets = {};
		for (const vault of await this.listVaults(client)) {
			if (!vault.id || !vault.name) continue;
			const items: Record<string, Record<string, string>> = {};
			for (const summary of await client.listItems(vault.id)) {
				if (!summary.id) continue;
				const item = await client.getItemById(vault.id, summary.id);
				if (!item.title) continue;
				const fields: Record<string, string> = {};
				for (const field of item.fields ?? []) {
					if (field.label && field.value !== undefined && field.value !== '') {
						fields[field.label] = field.value;
					}
				}
				if (Object.keys(fields).length > 0) items[item.title] = fields;
			}
			secrets[vault.name] = items;
		}
		this.cachedSecrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.listVaults(this.createClient());
			return [true];
		} catch (error) {
			return [false, error instanceof Error ? error.message : 'Unknown error'];
		}
	}

	getSecret(name: string): unknown {
		return this.cachedSecrets[name];
	}

	hasSecret(name: string): boolean {
		return Object.hasOwn(this.cachedSecrets, name);
	}

	getSecretNames(): string[] {
		const names: string[] = [];
		for (const [vault, items] of Object.entries(this.cachedSecrets)) {
			for (const [item, fields] of Object.entries(items)) {
				for (const field of Object.keys(fields)) names.push(`${vault}.${item}.${field}`);
			}
		}
		return names;
	}

	private createClient(): OPConnect {
		let url: URL;
		try {
			url = new URL(this.serverUrl);
		} catch {
			throw new UserError('1Password Connect server URL is not a valid URL');
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new UserError('1Password Connect server URL must use http or https');
		}
		if (!this.accessToken) throw new UserError('1Password Connect access token is required');
		return OnePasswordConnect({ serverURL: this.serverUrl, token: this.accessToken });
	}

	/** Wraps SDK errors so vendor messages (which may echo request data) never surface. */
	private async listVaults(client: OPConnect) {
		try {
			return await client.listVaults();
		} catch (error) {
			const status =
				typeof error === 'object' && error !== null && 'status' in error
					? ` (status ${String(error.status)})`
					: '';
			throw new OperationalError(`Could not list 1Password vaults${status}`);
		}
	}
}
