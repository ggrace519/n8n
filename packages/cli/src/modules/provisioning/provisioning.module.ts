import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * SSO role provisioning. Not gated on a single license flag: the feature rides
 * on either SSO protocol, so the licence check ("SAML or OIDC") lives on the
 * endpoints instead.
 */
@BackendModule({ name: 'provisioning', instanceTypes: ['main'] })
export class ProvisioningModule implements ModuleInterface {
	async init() {
		await import('./provisioning.controller.js');
		await import('./role-mapping-rule.controller.js');

		const { ProvisioningService } = await import('./provisioning.service.js');
		// Instantiating the service also registers its pubsub reload handler.
		await Container.get(ProvisioningService).init();

		const { ProvisioningRoleDeletionChecker } = await import('./role-deletion-checker.js');
		const { RoleDeletionCheckProxy } = await import(
			'@/services/role-deletion-check-proxy.service.js'
		);
		Container.get(RoleDeletionCheckProxy).registerProvider(
			Container.get(ProvisioningRoleDeletionChecker),
		);
	}

	@OnShutdown()
	async shutdown() {
		const { ProvisioningExpressionEvaluator } = await import(
			'./provisioning-expression-evaluator.js'
		);
		await Container.get(ProvisioningExpressionEvaluator).shutdown();
	}
}
