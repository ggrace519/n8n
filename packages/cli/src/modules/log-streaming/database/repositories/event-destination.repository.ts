import { BaseRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { MessageEventBusDestinationOptions } from 'n8n-workflow';

import { EventDestinations } from '../entities';

@Service()
export class EventDestinationsRepository extends BaseRepository<EventDestinations> {
	constructor(dataSource: DataSource) {
		super(EventDestinations, dataSource.manager);
	}

	async getAll(): Promise<EventDestinations[]> {
		return await this.find();
	}

	/** Insert or fully replace the row for the given destination id. */
	async saveDestination(id: string, destination: MessageEventBusDestinationOptions): Promise<void> {
		await this.upsert({ id, destination }, ['id']);
	}

	async deleteById(id: string): Promise<void> {
		await this.delete({ id });
	}
}
