// Clean-room implementation. Sources: the fair-code SecretsProvider contract
// (../types.ts) and the public Google Cloud Secret Manager Node.js client
// documentation for @google-cloud/secret-manager (v1 SecretManagerServiceClient).
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { parseSecretValue } from './secret-value';
import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';

interface ServiceAccountKey {
	project_id: string;
	client_email: string;
	private_key: string;
}

function isServiceAccountKey(value: unknown): value is ServiceAccountKey {
	if (value === null || typeof value !== 'object') return false;
	const v: Record<string, unknown> = { ...value };
	return (
		typeof v.project_id === 'string' &&
		v.project_id.length > 0 &&
		typeof v.client_email === 'string' &&
		typeof v.private_key === 'string'
	);
}

/** Parsed without echoing the input: a parse error message can quote key material. */
export function parseServiceAccountKey(raw: unknown): ServiceAccountKey {
	let parsed: unknown;
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch {
		throw new UserError('Service account key is not valid JSON');
	}
	if (!isServiceAccountKey(parsed)) {
		throw new UserError(
			'Service account key must contain project_id, client_email and private_key',
		);
	}
	return parsed;
}

function decodePayload(data: Uint8Array | string | null | undefined): string | undefined {
	if (data === null || data === undefined) return undefined;
	return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

export class GcpSecretsManagerProvider extends SecretsProvider {
	name = 'gcpSecretsManager';

	displayName = 'Google Cloud Secret Manager';

	properties: INodeProperties[] = [
		{
			name: 'serviceAccountKey',
			displayName: 'Service Account Key',
			type: 'string',
			default: '',
			required: true,
			placeholder: '{ "type": "service_account", ... }',
			typeOptions: { password: true },
		},
	];

	private settings: IDataObject = {};

	private client: SecretManagerServiceClient | undefined;

	private projectId = '';

	private cachedSecrets: Record<string, unknown> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings ?? {};
		this.client = undefined;
	}

	private getClient(): SecretManagerServiceClient {
		if (!this.client) {
			const key = parseServiceAccountKey(this.settings.serviceAccountKey);
			this.projectId = key.project_id;
			this.client = new SecretManagerServiceClient({
				projectId: key.project_id,
				credentials: { client_email: key.client_email, private_key: key.private_key },
			});
		}
		return this.client;
	}

	private describeError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const raw = this.settings.serviceAccountKey;
		if (typeof raw !== 'string' || raw.length === 0) return message;
		let safe = message.split(raw).join('***');
		try {
			const key = parseServiceAccountKey(raw);
			safe = safe.split(key.private_key).join('***');
		} catch {}
		return safe;
	}

	private async probe(): Promise<void> {
		const client = this.getClient();
		await client.listSecrets(
			{ parent: `projects/${this.projectId}`, pageSize: 1 },
			{ autoPaginate: false },
		);
	}

	protected async doConnect(): Promise<void> {
		try {
			await this.probe();
		} catch (error) {
			if (error instanceof UserError) throw error;
			throw new UserError(
				`Could not connect to Google Cloud Secret Manager: ${this.describeError(error)}`,
			);
		}
	}

	async disconnect(): Promise<void> {
		await this.client?.close();
		this.client = undefined;
	}

	async update(): Promise<void> {
		const client = this.getClient();
		const next: Record<string, unknown> = {};
		// The async iterator follows nextPageToken across pages.
		for await (const secret of client.listSecretsAsync({ parent: `projects/${this.projectId}` })) {
			if (!secret.name) continue;
			const shortName = secret.name.split('/').pop() ?? secret.name;
			try {
				const [version] = await client.accessSecretVersion({
					name: `${secret.name}/versions/latest`,
				});
				const value = decodePayload(version.payload?.data);
				if (value !== undefined) next[shortName] = parseSecretValue(value);
			} catch {
				// A secret with no enabled version has no "latest"; skip it.
			}
		}
		this.cachedSecrets = next;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.probe();
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
