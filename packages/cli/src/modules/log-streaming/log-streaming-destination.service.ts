import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { Service } from '@n8n/di';
import type { MessageEventBusDestinationOptions } from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { EventMessageConfirmSource } from '@/eventbus/event-message-classes/event-message-confirm';
import {
	EventMessageGeneric,
	eventMessageGenericDestinationTestEvent,
} from '@/eventbus/event-message-classes/event-message-generic';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { createMessageEventBusDestination } from './create-message-event-bus-destination';
import { EventDestinationsRepository } from './database/repositories/event-destination.repository';
import type { MessageEventBusDestination } from './destinations/message-event-bus-destination';

type ConfirmCallback = (message: EventMessageTypes, source: EventMessageConfirmSource) => void;

/**
 * Owns the registry of active log-streaming destinations.
 *
 * Delivery design: this service installs a single `"message"` listener on the
 * `MessageEventBus` and fans each event out to every enabled, subscribed
 * destination. Confirmation policy: each successfully delivered destination
 * confirms the message under its own identity; when no destination applies at
 * all, the message is confirmed as handled by the bus itself (mirroring the
 * bus's own no-listener behavior) so the event log does not accumulate
 * unconfirmed messages. When every applicable destination fails, the message
 * stays unconfirmed so the bus's unsent-retry loop can retry it.
 */
@Service()
export class LogStreamingDestinationService {
	private readonly destinations = new Map<string, MessageEventBusDestination>();

	private isInitialized = false;

	private readonly messageListener = (msg: EventMessageTypes, confirmCallback: ConfirmCallback) => {
		void this.handleMessage(msg, confirmCallback);
	};

	constructor(
		private readonly logger: Logger,
		private readonly eventBus: MessageEventBus,
		private readonly repository: EventDestinationsRepository,
		private readonly outboundHttp: OutboundHttp,
	) {}

	/** Load persisted destinations and start listening for events. */
	async initialize(): Promise<void> {
		if (this.isInitialized) return;

		const rows = await this.repository.getAll();
		for (const row of rows) {
			try {
				const destination = createMessageEventBusDestination(
					this.eventBus,
					this.outboundHttp,
					row.destination,
				);
				this.destinations.set(destination.id, destination);
			} catch (error) {
				this.logger.error(
					`Could not restore log streaming destination "${row.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		this.eventBus.on('message', this.messageListener);
		this.isInitialized = true;
	}

	private async handleMessage(
		msg: EventMessageTypes,
		confirmCallback: ConfirmCallback,
	): Promise<void> {
		const applicable = [...this.destinations.values()].filter(
			(destination) => destination.enabled && destination.hasSubscribedToEvent(msg.eventName),
		);

		if (applicable.length === 0) {
			confirmCallback(msg, { id: '0', name: 'eventBus' });
			return;
		}

		await Promise.all(
			applicable.map(async (destination) => {
				const delivered = await destination.receiveFromEventBus(msg);
				if (delivered) confirmCallback(msg, { id: destination.id, name: destination.label });
			}),
		);
	}

	/**
	 * All active destinations as serialized options; with an id,
	 * zero or one matches in an array.
	 */
	async findDestination(id?: string): Promise<MessageEventBusDestinationOptions[]> {
		if (id !== undefined) {
			const destination = this.destinations.get(id);
			return destination ? [destination.serialize()] : [];
		}
		return [...this.destinations.values()].map((destination) => destination.serialize());
	}

	/**
	 * Persist and activate a destination. An existing destination with the
	 * same id is fully replaced (its transport resources are closed first).
	 */
	async addDestination(
		destination: MessageEventBusDestination,
	): Promise<MessageEventBusDestination> {
		const existing = this.destinations.get(destination.id);
		if (existing) await existing.close();

		this.destinations.set(destination.id, destination);
		await this.repository.saveDestination(destination.id, destination.serialize());
		return destination;
	}

	/**
	 * Deactivate a destination and close its transport resources.
	 * Unless `persist` is `false`, the stored row is deleted as well.
	 */
	async removeDestination(id: string, persist: boolean = true): Promise<void> {
		const destination = this.destinations.get(id);
		if (destination) {
			await destination.close();
			this.destinations.delete(id);
		}
		if (persist) await this.repository.deleteById(id);
	}

	/**
	 * Attempt a test delivery, bypassing the destination's enabled state and
	 * event subscriptions. Returns whether delivery succeeded; an unknown id
	 * is a failed test, not an error.
	 */
	async testDestination(id: string): Promise<boolean> {
		const destination = this.destinations.get(id);
		if (!destination) return false;

		const testMessage = new EventMessageGeneric({
			eventName: eventMessageGenericDestinationTestEvent,
			payload: { msg: `Test message from n8n to destination "${destination.label}"` },
		});
		return await destination.receiveFromEventBus(testMessage);
	}

	/** Stop listening and release every destination's transport resources. */
	async shutdown(): Promise<void> {
		this.eventBus.removeListener('message', this.messageListener);
		await Promise.all([...this.destinations.values()].map(async (d) => await d.close()));
		this.destinations.clear();
		this.isInitialized = false;
	}
}
