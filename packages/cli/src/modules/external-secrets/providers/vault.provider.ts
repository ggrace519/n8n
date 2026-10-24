// Clean-room implementation built from the fair-code SecretsProvider contract
// (../types.ts) and the public HashiCorp Vault HTTP API docs (see ./vault-client.ts).
import type { INodeProperties } from 'n8n-workflow';
import { UnexpectedError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';
import { VaultClient } from './vault-client';
import type { VaultAuthMethod, VaultConnectionSettings } from './vault-client';

type SecretTree = Record<string, unknown>;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === 'string' ? value.trim() : '';
}

function toAuthMethod(value: string): VaultAuthMethod {
	return value === 'appRole' || value === 'usernameAndPassword' ? value : 'token';
}

function setNested(tree: SecretTree, segments: string[], value: unknown): void {
	if (segments.some((segment) => UNSAFE_KEYS.has(segment))) return;
	let node = tree;
	for (const segment of segments.slice(0, -1)) {
		const child = node[segment];
		if (isRecord(child)) {
			node = child;
		} else {
			const next: SecretTree = {};
			node[segment] = next;
			node = next;
		}
	}
	node[segments[segments.length - 1]] = value;
}

function collectNames(tree: SecretTree, prefix: string, out: string[]): void {
	for (const [key, value] of Object.entries(tree)) {
		const name = prefix ? `${prefix}.${key}` : key;
		if (isRecord(value)) collectNames(value, name, out);
		else out.push(name);
	}
}

const authOptions = (method: VaultAuthMethod) => ({ show: { authMethod: [method] } });

export class VaultProvider extends SecretsProvider {
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
		{ name: 'namespace', displayName: 'Namespace', type: 'string', default: '' },
		{
			name: 'authMethod',
			displayName: 'Authentication Method',
			type: 'options',
			default: 'token',
			options: [
				{ name: 'Token', value: 'token' },
				{ name: 'AppRole', value: 'appRole' },
				{ name: 'Username and Password', value: 'usernameAndPassword' },
			],
		},
		{
			name: 'token',
			displayName: 'Token',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			displayOptions: authOptions('token'),
		},
		{
			name: 'roleId',
			displayName: 'Role ID',
			type: 'string',
			default: '',
			required: true,
			displayOptions: authOptions('appRole'),
		},
		{
			name: 'secretId',
			displayName: 'Secret ID',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			displayOptions: authOptions('appRole'),
		},
		{
			name: 'username',
			displayName: 'Username',
			type: 'string',
			default: '',
			required: true,
			displayOptions: authOptions('usernameAndPassword'),
		},
		{
			name: 'password',
			displayName: 'Password',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			displayOptions: authOptions('usernameAndPassword'),
		},
	];

	private connection: VaultConnectionSettings | undefined;

	private client: VaultClient | undefined;

	private cachedSecrets: SecretTree = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		const raw: Record<string, unknown> = settings.settings ?? {};
		this.connection = {
			url: readString(raw, 'url'),
			namespace: readString(raw, 'namespace'),
			authMethod: toAuthMethod(readString(raw, 'authMethod')),
			token: readString(raw, 'token'),
			roleId: readString(raw, 'roleId'),
			secretId: readString(raw, 'secretId'),
			username: readString(raw, 'username'),
			password: typeof raw.password === 'string' ? raw.password : '',
		};
		this.client = undefined;
	}

	protected async doConnect(): Promise<void> {
		this.client = await this.createAuthenticatedClient();
	}

	async disconnect(): Promise<void> {
		this.client = undefined;
	}

	async update(): Promise<void> {
		let client = this.client;
		if (!client) {
			client = await this.createAuthenticatedClient();
		} else if (this.connection?.authMethod !== 'token') {
			// Login tokens expire; re-authenticate each refresh so the cache keeps updating.
			await client.authenticate();
		}
		this.client = client;

		const tree: SecretTree = {};
		for (const mount of await client.listKvMounts()) {
			const mountSegments = mount.path.split('/').filter(Boolean);
			for (const path of await client.listSecretPaths(mount)) {
				const values = await client.readSecret(mount, path);
				if (!values) continue;
				setNested(tree, [...mountSegments, ...path.split('/').filter(Boolean)], values);
			}
		}
		this.cachedSecrets = tree;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.createAuthenticatedClient();
			return [true];
		} catch (error) {
			return [false, error instanceof Error ? error.message : 'Unknown error'];
		}
	}

	getSecret(name: string): unknown {
		let node: unknown = this.cachedSecrets;
		for (const segment of name.split('.')) {
			if (!isRecord(node) || !Object.hasOwn(node, segment)) return undefined;
			node = node[segment];
		}
		return node;
	}

	hasSecret(name: string): boolean {
		return this.getSecret(name) !== undefined;
	}

	getSecretNames(): string[] {
		const names: string[] = [];
		collectNames(this.cachedSecrets, '', names);
		return names;
	}

	private async createAuthenticatedClient(): Promise<VaultClient> {
		if (!this.connection) throw new UnexpectedError('Vault provider is not initialised');
		const client = new VaultClient(this.connection);
		await client.authenticate();
		return client;
	}
}
