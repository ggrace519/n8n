import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({ name: 'ldap' })
export class LdapModule implements ModuleInterface {
	async init() {
		await import('./ldap.controller.js');
		// Decorating the class registers it with the auth-handler registry.
		await import('./ldap.auth-handler.js');

		const { LdapService } = await import('./ldap.service.js');
		await Container.get(LdapService).init();
	}

	@OnShutdown()
	async shutdown() {
		const { LdapService } = await import('./ldap.service.js');
		Container.get(LdapService).stopSync();
	}
}
