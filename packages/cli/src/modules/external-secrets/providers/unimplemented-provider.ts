import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { OperationalError } from 'n8n-workflow';

import { SecretsProvider } from '../types';
import type { SecretsProviderSettings } from '../types';

/**
 * Base for the catalogued provider types whose vendor integration this fork does
 * not ship.
 *
 * The provider *identities* and their settings forms are part of the public API
 * (the DTO enum and the provider-type endpoints), so the catalog must expose
 * them. The store conversation itself — authentication, paths, pagination,
 * versioning — is not, so rather than guess at a vendor protocol these
 * providers fail loudly on connect. A wrong guess would silently hand
 * credentials to the wrong endpoint; an explicit failure cannot.
 */
export abstract class UnimplementedSecretsProvider extends SecretsProvider {
	abstract name: string;

	abstract displayName: string;

	abstract properties: INodeProperties[];

	protected settings: IDataObject = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings ?? {};
	}

	protected async doConnect(): Promise<void> {
		throw new OperationalError(this.unavailableMessage());
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		throw new OperationalError(this.unavailableMessage());
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		return [false, this.unavailableMessage()];
	}

	getSecret(_name: string): unknown {
		return undefined;
	}

	hasSecret(_name: string): boolean {
		return false;
	}

	getSecretNames(): string[] {
		return [];
	}

	private unavailableMessage(): string {
		return `No integration is available for the "${this.displayName}" secrets provider on this instance`;
	}
}
