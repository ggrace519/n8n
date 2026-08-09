import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import type {
	INodeCredentials,
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';
import { defaultMessageEventBusDestinationOptions } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { AbstractEventMessageOptions } from '@/eventbus/event-message-classes/abstract-event-message-options';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

/**
 * Base class for log-streaming destinations (webhook, sentry, syslog).
 *
 * A destination holds its canonical options, decides which events it is
 * subscribed to, and performs the actual delivery in `sendTo()`. Delivery
 * errors are always contained here (logged, reported as `false`) so that a
 * failing destination can never break `MessageEventBus.send()`.
 */
export abstract class MessageEventBusDestination {
	readonly id: string;

	label: string;

	enabled: boolean;

	subscribedEvents: string[];

	credentials: INodeCredentials;

	anonymizeAuditMessages: boolean;

	circuitBreaker?: MessageEventBusDestinationOptions['circuitBreaker'];

	protected readonly logger: Logger;

	abstract readonly __type: MessageEventBusDestinationTypeNames;

	constructor(
		protected readonly eventBus: MessageEventBus,
		options: MessageEventBusDestinationOptions,
	) {
		const defaults = defaultMessageEventBusDestinationOptions;
		this.id = options.id && options.id.length > 0 ? options.id : uuid();
		this.label = options.label ?? defaults.label ?? 'New Event Destination';
		this.enabled = options.enabled ?? defaults.enabled ?? true;
		this.subscribedEvents = options.subscribedEvents ?? [
			...(defaults.subscribedEvents ?? ['n8n.audit', 'n8n.workflow']),
		];
		this.credentials = options.credentials ?? {};
		this.anonymizeAuditMessages = options.anonymizeAuditMessages ?? false;
		this.circuitBreaker = options.circuitBreaker;
		this.logger = Container.get(Logger);
	}

	/**
	 * Segment-aware subscription check: a subscription matches the exact event
	 * name, acts as a namespace prefix on a `.` boundary, or is the `*` wildcard.
	 */
	hasSubscribedToEvent(eventName: string): boolean {
		for (const subscribed of this.subscribedEvents) {
			if (subscribed === '*' || subscribed === eventName) return true;
			if (eventName.startsWith(`${subscribed}.`)) return true;
		}
		return false;
	}

	/**
	 * Deliver a message to this destination, containing any delivery error.
	 * Returns whether delivery succeeded.
	 */
	async receiveFromEventBus(msg: EventMessageTypes): Promise<boolean> {
		try {
			return await this.sendTo(msg);
		} catch (error) {
			// log the raw error message: transport errors carry their own context
			this.logger.error(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	/** Perform the actual delivery. May throw; callers go through `receiveFromEventBus`. */
	protected abstract sendTo(msg: EventMessageTypes): Promise<boolean>;

	/**
	 * The event message as it should be shipped to the destination, applying
	 * audit-payload anonymization when configured.
	 */
	protected payloadFor(msg: EventMessageTypes): AbstractEventMessageOptions {
		const serialized = msg.serialize();
		if (this.anonymizeAuditMessages && msg.eventName.startsWith('n8n.audit.')) {
			serialized.payload = msg.anonymize();
		}
		return serialized;
	}

	/** Canonical internal options, including the discriminator and id. */
	serialize(): MessageEventBusDestinationOptions {
		return {
			__type: this.__type,
			id: this.id,
			label: this.label,
			enabled: this.enabled,
			subscribedEvents: this.subscribedEvents,
			credentials: this.credentials,
			anonymizeAuditMessages: this.anonymizeAuditMessages,
			...(this.circuitBreaker ? { circuitBreaker: this.circuitBreaker } : {}),
		};
	}

	/** Release any transport resources. Safe to call multiple times. */
	async close(): Promise<void> {}
}
