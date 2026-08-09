import { LICENSE_FEATURES } from '@n8n/constants';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * External secrets: resolve `$secrets.<provider>.<name>` in credentials from a
 * secrets store instead of persisting the value in n8n.
 *
 * Not restricted to `main`: `$secrets` is resolved while a workflow executes, so
 * a worker needs its own connected providers too.
 */
@BackendModule({
	name: 'external-secrets',
	licenseFlag: LICENSE_FEATURES.EXTERNAL_SECRETS,
})
export class ExternalSecretsModule implements ModuleInterface {
	async init() {
		await import('./external-secrets.controller.js');
		await import('./secret-providers-connections.controller.js');
		await import('./secret-providers-project.controller.js');
		await import('./secret-providers-types.controller.js');
		await import('./secret-providers-completions.controller.js');

		const { ExternalSecretsManager } = await import('./external-secrets-manager.js');
		// Constructing the manager also registers its `reload-external-secrets-providers`
		// pubsub handler and wires it into `ExternalSecretsProxy`.
		await Container.get(ExternalSecretsManager).init();

		const { ExternalSecretsProjectCleanup } = await import('./project-cleanup.service.js');
		const { OwnershipTransferHandlerRegistry } = await import(
			'@/services/ownership-transfer/ownership-transfer-handler.registry.js'
		);
		Container.get(OwnershipTransferHandlerRegistry).register(
			Container.get(ExternalSecretsProjectCleanup),
		);
	}

	/** Settings exposed to the client via `/rest/module-settings`. */
	async settings() {
		const { ExternalSecretsConfig } = await import('./external-secrets.config.js');
		const { ExternalSecretsSystemRolesStore } = await import('./system-roles-store.service.js');

		const config = Container.get(ExternalSecretsConfig);

		return {
			multipleConnections: config.externalSecretsMultipleConnections,
			forProjects: config.externalSecretsForProjects,
			// Per-project connection roles only exist under the connection-entity model.
			roleBasedAccess: config.externalSecretsForProjects,
			systemRolesEnabled: await Container.get(ExternalSecretsSystemRolesStore).isEnabled(),
		};
	}

	@OnShutdown()
	async shutdown() {
		const { ExternalSecretsManager } = await import('./external-secrets-manager.js');
		await Container.get(ExternalSecretsManager).shutdown();
	}
}
