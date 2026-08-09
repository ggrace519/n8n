import type { SecretProviderTypeResponse } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Get, Param, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { ExternalSecretsProviders } from './external-secrets-providers';

/**
 * The catalog stays runtime-extensible, so the reported type is the registered
 * key rather than the narrower published enum.
 */
export type SecretProviderTypeMetadata = Omit<SecretProviderTypeResponse, 'type'> & {
	type: string;
};

/**
 * Provider-type metadata used to render the connection form.
 *
 * Deliberately unscoped beyond authentication: the response is a form
 * definition — field names, labels and which fields are passwords — and carries
 * no instance configuration or secret material. Anyone who may write a
 * `$secrets` expression needs it to make sense of the provider it names.
 */
@RestController('/secret-providers/types')
export class SecretProvidersTypesController {
	constructor(private readonly externalSecretsProviders: ExternalSecretsProviders) {}

	@Get('/')
	async list(): Promise<SecretProviderTypeMetadata[]> {
		return Object.keys(this.externalSecretsProviders.providers).map((type) => this.describe(type));
	}

	@Get('/:type')
	async get(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('type') type: string,
	): Promise<SecretProviderTypeMetadata> {
		if (this.externalSecretsProviders.providers[type] === undefined) {
			throw new NotFoundError(`Provider type "${type}" not found`);
		}

		return this.describe(type);
	}

	private describe(type: string): SecretProviderTypeMetadata {
		const Provider = this.externalSecretsProviders.providers[type];
		const provider = new Provider();

		return {
			type,
			displayName: provider.displayName,
			icon: provider.icon ?? provider.name,
			properties: provider.properties,
		};
	}
}
