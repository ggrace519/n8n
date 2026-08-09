import { Logger } from '@n8n/backend-common';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * End-user ("private") credentials: credential data resolved per execution
 * identity instead of being shared by everyone who can read the credential.
 *
 * No `instanceTypes` restriction on purpose — webhook and worker processes
 * resolve credentials too, so limiting init to `main` would break production
 * runs.
 */
@BackendModule({ name: 'dynamic-credentials', licenseFlag: 'feat:dynamicCredentials' })
export class DynamicCredentialsModule implements ModuleInterface {
	async init() {
		await import('./credential-resolver.controller.js');

		const { DynamicCredentialsProxy } = await import('@/credentials/dynamic-credentials-proxy.js');
		const { CredentialConnectionStatusProxy } = await import(
			'@/credentials/credential-connection-status-proxy.js'
		);
		const { CredentialResolverService } = await import('./services/credential-resolver.service.js');
		const { CredentialConnectionStatusService } = await import(
			'./services/credential-connection-status.service.js'
		);

		const resolverService = Container.get(CredentialResolverService);
		const proxy = Container.get(DynamicCredentialsProxy);
		proxy.setResolverProvider(resolverService);
		proxy.setStorageProvider(resolverService);

		Container.get(CredentialConnectionStatusProxy).setProvider(
			Container.get(CredentialConnectionStatusService),
		);

		await this.seedSystemResolver();
	}

	async entities() {
		const { DynamicCredentialResolver } = await import(
			'./database/entities/credential-resolver.js'
		);
		const { DynamicCredentialEntry } = await import(
			'./database/entities/dynamic-credential-entry.js'
		);
		const { DynamicCredentialUserEntry } = await import(
			'./database/entities/dynamic-credential-user-entry.js'
		);

		return [DynamicCredentialResolver, DynamicCredentialEntry, DynamicCredentialUserEntry];
	}

	async context() {
		const { CredentialCheckService } = await import('./services/credential-check.service.js');

		return { credentialCheckProxy: Container.get(CredentialCheckService) };
	}

	/**
	 * The system resolver must exist before any credential can be connected, and
	 * every process that initializes the module races to create it — so the
	 * insert ignores a conflict on the well-known id instead of overwriting a row
	 * another process (or an operator) already owns.
	 */
	private async seedSystemResolver(): Promise<void> {
		const { DynamicCredentialResolverRepository } = await import(
			'./database/repositories/credential-resolver.repository.js'
		);
		const { SYSTEM_RESOLVER_ID, SYSTEM_RESOLVER_NAME, SYSTEM_RESOLVER_TYPE } = await import(
			'./constants.js'
		);

		try {
			await Container.get(DynamicCredentialResolverRepository).insertIfAbsent(
				{
					id: SYSTEM_RESOLVER_ID,
					name: SYSTEM_RESOLVER_NAME,
					type: SYSTEM_RESOLVER_TYPE,
					config: '{}',
				},
				{},
			);
		} catch (error) {
			// Seeding must never block startup: without it the feature degrades to
			// "nothing is connected" rather than taking the process down.
			Container.get(Logger).error('Failed to seed the system credential resolver', { error });
		}
	}
}
