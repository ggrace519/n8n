import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({ name: 'log-streaming', licenseFlag: 'feat:logStreaming' })
export class LogStreamingModule implements ModuleInterface {
	async init() {
		await import('./log-streaming.controller.js');

		const { LogStreamingDestinationService } = await import(
			'./log-streaming-destination.service.js'
		);
		await Container.get(LogStreamingDestinationService).initialize();
	}

	async entities() {
		const { EventDestinations } = await import('./database/entities/index.js');

		return [EventDestinations];
	}

	@OnShutdown()
	async shutdown() {
		const { LogStreamingDestinationService } = await import(
			'./log-streaming-destination.service.js'
		);
		await Container.get(LogStreamingDestinationService).shutdown();
	}
}
