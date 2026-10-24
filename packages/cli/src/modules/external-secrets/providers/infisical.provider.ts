// Clean-room implementation. Sources: this repo's fair-code SecretsProvider
// contract (../types.ts) and the public Infisical REST API docs (Universal Auth
// login `POST /api/v1/auth/universal-auth/login`, `GET /api/v3/secrets/raw`).
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { OperationalError, UserError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh a little before the server-side expiry to avoid racing it. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

interface InfisicalSettings {
	siteURL: string;
	clientId: string;
	clientSecret: string;
	projectId: string;
	environment: string;
	secretPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export class InfisicalProvider extends SecretsProvider {
	name = 'infisical';

	displayName = 'Infisical';

	properties: INodeProperties[] = [
		{
			name: 'siteURL',
			displayName: 'Site URL',
			type: 'string',
			default: 'https://app.infisical.com',
			required: true,
		},
		{ name: 'clientId', displayName: 'Client ID', type: 'string', default: '', required: true },
		{
			name: 'clientSecret',
			displayName: 'Client Secret',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
		},
		{ name: 'projectId', displayName: 'Project ID', type: 'string', default: '', required: true },
		{
			name: 'environment',
			displayName: 'Environment Slug',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'prod',
		},
		{ name: 'secretPath', displayName: 'Secret Path', type: 'string', default: '/' },
	];

	private settings: InfisicalSettings = {
		siteURL: 'https://app.infisical.com',
		clientId: '',
		clientSecret: '',
		projectId: '',
		environment: '',
		secretPath: '/',
	};

	private accessToken?: string;

	private tokenExpiresAt = 0;

	private cachedSecrets: Record<string, string> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		const s: IDataObject = settings.settings ?? {};
		this.settings = {
			siteURL: str(s.siteURL, 'https://app.infisical.com').replace(/\/+$/, ''),
			clientId: str(s.clientId),
			clientSecret: str(s.clientSecret),
			projectId: str(s.projectId),
			environment: str(s.environment),
			secretPath: str(s.secretPath, '/'),
		};
		this.accessToken = undefined;
		this.tokenExpiresAt = 0;
	}

	protected async doConnect(): Promise<void> {
		this.validateSettings();
		await this.login();
		await this.update();
	}

	async disconnect(): Promise<void> {
		this.accessToken = undefined;
		this.tokenExpiresAt = 0;
		this.cachedSecrets = {};
	}

	async update(): Promise<void> {
		if (!this.accessToken || Date.now() >= this.tokenExpiresAt) await this.login();
		this.cachedSecrets = await this.fetchSecrets();
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			this.validateSettings();
			await this.login();
			await this.fetchSecrets();
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
		return Object.keys(this.cachedSecrets);
	}

	private validateSettings(): void {
		let url: URL;
		try {
			url = new URL(this.settings.siteURL);
		} catch {
			throw new UserError('Infisical site URL is not a valid URL');
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new UserError('Infisical site URL must use http or https');
		}
		const { clientId, clientSecret, projectId, environment } = this.settings;
		if (!clientId || !clientSecret || !projectId || !environment) {
			throw new UserError(
				'Infisical client ID, client secret, project ID and environment are required',
			);
		}
	}

	private async login(): Promise<void> {
		const body = await this.request('/api/v1/auth/universal-auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
			}),
		});
		if (!isRecord(body) || typeof body.accessToken !== 'string') {
			throw new OperationalError('Infisical login returned an unexpected response');
		}
		this.accessToken = body.accessToken;
		const expiresIn = typeof body.expiresIn === 'number' ? body.expiresIn : 0;
		this.tokenExpiresAt = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS;
	}

	private async fetchSecrets(): Promise<Record<string, string>> {
		const query = new URLSearchParams({
			workspaceId: this.settings.projectId,
			environment: this.settings.environment,
			secretPath: this.settings.secretPath,
		});
		const body = await this.request(`/api/v3/secrets/raw?${query.toString()}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${this.accessToken ?? ''}` },
		});
		if (!isRecord(body) || !Array.isArray(body.secrets)) {
			throw new OperationalError('Infisical returned an unexpected secrets response');
		}
		const secrets: Record<string, string> = {};
		for (const entry of body.secrets) {
			if (isRecord(entry) && typeof entry.secretKey === 'string') {
				secrets[entry.secretKey] = typeof entry.secretValue === 'string' ? entry.secretValue : '';
			}
		}
		return secrets;
	}

	/** Error messages carry only the status code — never the request or response body. */
	private async request(path: string, init: RequestInit): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`${this.settings.siteURL}${path}`, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new OperationalError('Could not reach the Infisical server');
		}
		if (!response.ok) {
			throw new OperationalError(`Infisical request failed with status ${response.status}`);
		}
		return await response.json();
	}
}
