// Clean-room HTTP client for HashiCorp Vault, built from the public Vault HTTP API
// docs (auth/token, auth/approle, auth/userpass, sys/mounts, KV v1 and v2 secrets engines).
import { OperationalError, UserError } from 'n8n-workflow';

export type VaultAuthMethod = 'token' | 'appRole' | 'usernameAndPassword';

export interface VaultConnectionSettings {
	url: string;
	namespace: string;
	authMethod: VaultAuthMethod;
	token: string;
	roleId: string;
	secretId: string;
	username: string;
	password: string;
}

export interface KvMount {
	/** Mount path without trailing slash, e.g. `secret`. */
	path: string;
	version: 1 | 2;
}

const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodePath(path: string): string {
	return path
		.split('/')
		.filter((segment) => segment.length > 0)
		.map(encodeURIComponent)
		.join('/');
}

export function parseVaultUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new UserError('Vault URL is invalid');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new UserError('Vault URL must use http or https');
	}
	return parsed.toString().replace(/\/+$/, '');
}

export class VaultClient {
	private readonly baseUrl: string;

	private clientToken: string | undefined;

	constructor(private readonly settings: VaultConnectionSettings) {
		this.baseUrl = parseVaultUrl(settings.url);
	}

	/** Obtain (or re-obtain) a client token for the configured auth method. */
	async authenticate(): Promise<void> {
		const { authMethod } = this.settings;
		if (authMethod === 'token') {
			if (!this.settings.token) throw new UserError('Vault token is required');
			this.clientToken = this.settings.token;
			await this.request('GET', 'auth/token/lookup-self');
			return;
		}
		let body: unknown;
		if (authMethod === 'appRole') {
			const { roleId, secretId } = this.settings;
			if (!roleId || !secretId)
				throw new UserError('Vault AppRole role ID and secret ID are required');
			body = await this.request(
				'POST',
				'auth/approle/login',
				{ role_id: roleId, secret_id: secretId },
				false,
			);
		} else {
			const { username, password } = this.settings;
			if (!username || !password) throw new UserError('Vault username and password are required');
			body = await this.request('POST', `auth/userpass/login/${username}`, { password }, false);
		}
		const auth = isRecord(body) ? body.auth : undefined;
		const token = isRecord(auth) ? auth.client_token : undefined;
		if (typeof token !== 'string' || !token) {
			throw new OperationalError('Vault login response did not include a client token');
		}
		this.clientToken = token;
	}

	async listKvMounts(): Promise<KvMount[]> {
		const body = await this.request('GET', 'sys/mounts');
		const source = isRecord(body) && isRecord(body.data) ? body.data : body;
		if (!isRecord(source)) return [];
		const mounts: KvMount[] = [];
		for (const [path, info] of Object.entries(source)) {
			if (!isRecord(info) || (info.type !== 'kv' && info.type !== 'generic')) continue;
			const options = isRecord(info.options) ? info.options : {};
			mounts.push({ path: path.replace(/\/+$/, ''), version: options.version === '2' ? 2 : 1 });
		}
		return mounts;
	}

	/** Recursively collect all secret paths (relative to the mount) under `prefix`. */
	async listSecretPaths(mount: KvMount, prefix = ''): Promise<string[]> {
		const base = mount.version === 2 ? `${mount.path}/metadata` : mount.path;
		const body = await this.request('LIST', `${base}/${prefix}`, undefined, true, true);
		const data = isRecord(body) ? body.data : undefined;
		const keys = isRecord(data) && Array.isArray(data.keys) ? data.keys : [];
		const paths: string[] = [];
		for (const key of keys) {
			if (typeof key !== 'string') continue;
			if (key.endsWith('/')) {
				paths.push(...(await this.listSecretPaths(mount, `${prefix}${key}`)));
			} else {
				paths.push(`${prefix}${key}`);
			}
		}
		return paths;
	}

	async readSecret(mount: KvMount, path: string): Promise<Record<string, unknown> | undefined> {
		const target = mount.version === 2 ? `${mount.path}/data/${path}` : `${mount.path}/${path}`;
		const body = await this.request('GET', target, undefined, true, true);
		const data = isRecord(body) ? body.data : undefined;
		const values = mount.version === 2 && isRecord(data) ? data.data : data;
		return isRecord(values) ? values : undefined;
	}

	private async request(
		method: 'GET' | 'POST' | 'LIST',
		path: string,
		payload?: Record<string, string>,
		withToken = true,
		allowNotFound = false,
	): Promise<unknown> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (this.settings.namespace) headers['X-Vault-Namespace'] = this.settings.namespace;
		if (withToken) {
			if (!this.clientToken) throw new OperationalError('Vault client is not authenticated');
			headers['X-Vault-Token'] = this.clientToken;
		}
		if (payload) headers['Content-Type'] = 'application/json';
		const url = `${this.baseUrl}/v1/${encodePath(path)}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: payload ? JSON.stringify(payload) : undefined,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: 'error',
			});
		} catch (error) {
			const reason = error instanceof Error ? error.name : 'unknown';
			throw new OperationalError(`Could not reach Vault (${reason})`);
		}
		if (allowNotFound && response.status === 404) return undefined;
		if (!response.ok) {
			// Status only: Vault error bodies can echo request details.
			throw new OperationalError(`Vault request failed with status ${response.status}`);
		}
		if (response.status === 204) return undefined;
		try {
			return await response.json();
		} catch {
			throw new OperationalError('Vault returned an invalid JSON response');
		}
	}
}
