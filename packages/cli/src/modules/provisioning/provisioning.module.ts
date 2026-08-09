import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Minimal registration so the module loader and `main-only-modules` metadata
 * pin resolve. The provisioning controller/config surface is rebuilt
 * separately (see provisioning-config.api.test.ts for the pinned contract).
 */
@BackendModule({ name: 'provisioning', instanceTypes: ['main'] })
export class ProvisioningModule implements ModuleInterface {
	async init() {}
}
