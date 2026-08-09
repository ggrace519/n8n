import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({
	name: 'source-control',
	instanceTypes: ['main'],
	licenseFlag: 'feat:sourceControl',
})
export class SourceControlModule implements ModuleInterface {
	async init() {
		await import('./source-control.controller.js');

		const { SourceControlPreferencesService } = await import(
			'./source-control-preferences.service.js'
		);
		await Container.get(
			SourceControlPreferencesService,
		).loadFromDbAndApplySourceControlPreferences();

		// Instantiate the service so its pubsub handler
		// (`reload-source-control-config`) is registered.
		const { SourceControlService } = await import('./source-control.service.js');
		Container.get(SourceControlService);
	}
}
