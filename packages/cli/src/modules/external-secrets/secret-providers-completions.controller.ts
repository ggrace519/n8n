import type { SecretCompletionsResponse } from '@n8n/api-types';
import { SecretsProviderConnectionRepository } from '@n8n/db';
import { Get, GlobalScope, Param, ProjectScope, RestController } from '@n8n/decorators';

import { ExternalSecretsManager } from './external-secrets-manager';

/**
 * Secret names offered as expression completions.
 *
 * Only names are returned, never values — completions are shown to anyone who
 * can edit an expression, while reading a secret's value stays confined to
 * credential evaluation at execution time.
 */
@RestController('/secret-providers/completions')
export class SecretProvidersCompletionsController {
	constructor(
		private readonly externalSecretsManager: ExternalSecretsManager,
		private readonly connectionRepository: SecretsProviderConnectionRepository,
	) {}

	@Get('/secrets/global')
	@GlobalScope('externalSecret:list')
	async globalSecrets(): Promise<SecretCompletionsResponse> {
		return await this.secretsOf(await this.connectionRepository.findEnabledGlobalConnections());
	}

	/**
	 * The same global-only data, authorised against a project — lets a user with
	 * project-level access complete global secrets without an instance-wide scope.
	 */
	@Get('/secrets/global/:projectId')
	@ProjectScope('externalSecret:list')
	async globalSecretsForProject(): Promise<SecretCompletionsResponse> {
		return await this.secretsOf(await this.connectionRepository.findEnabledGlobalConnections());
	}

	@Get('/secrets/project/:projectId')
	@ProjectScope('externalSecret:list')
	async projectSecrets(
		_req: unknown,
		_res: unknown,
		@Param('projectId') projectId: string,
	): Promise<SecretCompletionsResponse> {
		// An unknown project simply has no connections; it is not an error to ask.
		return await this.secretsOf(await this.connectionRepository.findEnabledByProjectId(projectId));
	}

	private async secretsOf(
		connections: Array<{ providerKey: string }>,
	): Promise<SecretCompletionsResponse> {
		return Object.fromEntries(
			connections.map((connection) => [
				connection.providerKey,
				this.externalSecretsManager.getSecretNames(connection.providerKey),
			]),
		);
	}
}
