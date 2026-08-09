import { JsonColumn, WithTimestamps } from '@n8n/db';
import { Entity, PrimaryColumn } from '@n8n/typeorm';
import type { MessageEventBusDestinationOptions } from 'n8n-workflow';

/**
 * A configured log-streaming destination. The row id always equals the
 * `id` inside the serialized destination options (`destination.id`).
 */
@Entity()
export class EventDestinations extends WithTimestamps {
	@PrimaryColumn('uuid')
	id: string;

	@JsonColumn()
	destination: MessageEventBusDestinationOptions;
}
