import { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Post, RestController } from '@n8n/decorators';
import type { Response } from 'express';
import type { IDataObject } from 'n8n-workflow';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { ExternalSecretsManager } from './external-secrets-manager';
import type { LegacyProviderSummary } from './external-secrets-manager';

type ProviderParams = { provider: string };
type ConnectBody = { connected?: boolean };

/**
 * The single-connection API: one provider per type, configured through the
 * legacy `feature.externalSecrets` settings row. Active while neither project
 * scoping nor multi-connection support is switched on.
 */
@RestController('/external-secrets')
export class ExternalSecretsController {
	constructor(private readonly externalSecretsManager: ExternalSecretsManager) {}

	@Get('/providers')
	@GlobalScope('externalSecretsProvider:list')
	async getProviders(): Promise<LegacyProviderSummary[]> {
		return this.externalSecretsManager.getLegacyProviderSummaries();
	}

	@Get('/providers/:provider')
	@GlobalScope('externalSecretsProvider:read')
	async getProvider(req: AuthenticatedRequest<ProviderParams>): Promise<LegacyProviderSummary> {
		return this.requireProvider(req.params.provider);
	}

	/** Replace a provider's settings. Blanked password fields keep their stored value. */
	@Post('/providers/:provider')
	@GlobalScope('externalSecretsProvider:update')
	async setProviderSettings(
		req: AuthenticatedRequest<ProviderParams, unknown, IDataObject>,
	): Promise<{ updated: true }> {
		const providerName = req.params.provider;
		this.requireProvider(providerName);

		await this.externalSecretsManager.setProviderSettings(providerName, req.body, req.user.id);
		return { updated: true };
	}

	@Post('/providers/:provider/connect')
	@GlobalScope('externalSecretsProvider:update')
	async setProviderConnected(
		req: AuthenticatedRequest<ProviderParams, unknown, ConnectBody>,
	): Promise<{ updated: true }> {
		const providerName = req.params.provider;
		this.requireProvider(providerName);

		await this.externalSecretsManager.setProviderConnected(
			providerName,
			req.body?.connected === true,
		);
		return { updated: true };
	}

	/**
	 * Try settings without storing them. A provider that rejects them is reported
	 * as a client error, matching how the settings form treats a bad configuration.
	 */
	@Post('/providers/:provider/test')
	@GlobalScope('externalSecretsProvider:sync')
	async testProviderSettings(
		req: AuthenticatedRequest<ProviderParams, unknown, IDataObject>,
		res: Response,
	): Promise<{ success: boolean; testState: 'connected' | 'error' }> {
		const providerName = req.params.provider;
		this.requireProvider(providerName);

		const [success] = await this.externalSecretsManager.testProviderSettings(
			providerName,
			req.body,
		);

		if (!success) res.status(400);

		return { success, testState: success ? 'connected' : 'error' };
	}

	/** Manual refresh. Refused while the provider is not connected. */
	@Post('/providers/:provider/update')
	@GlobalScope('externalSecretsProvider:sync')
	async updateProvider(
		req: AuthenticatedRequest<ProviderParams>,
		res: Response,
	): Promise<{ updated: boolean }> {
		const providerName = req.params.provider;
		this.requireProvider(providerName);

		const updated = await this.externalSecretsManager.updateProvider(providerName);
		if (!updated) res.status(400);

		return { updated };
	}

	@Get('/secrets')
	@GlobalScope('externalSecret:list')
	async getSecretNames(): Promise<Record<string, string[]>> {
		return this.externalSecretsManager.getAllSecretNames();
	}

	private requireProvider(providerName: string): LegacyProviderSummary {
		const provider = this.externalSecretsManager.getLegacyProviderSummary(providerName, true);
		if (provider === undefined) {
			throw new NotFoundError(`Could not find provider "${providerName}"`);
		}
		return provider;
	}
}
