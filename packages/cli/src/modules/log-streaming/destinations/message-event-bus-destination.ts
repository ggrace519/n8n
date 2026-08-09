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

import { DeliveryCircuitBreaker } from '../circuit-breaker';
import { CLOSE_DRAIN_TIMEOUT_MS, MAX_QUEUED_DELIVERIES } from '../constants';
import { BoundedDeliveryQueue } from '../delivery-queue';

export interface SerializeOptions {
	/** Replace secret-bearing option values with a placeholder (for read APIs). */
	redactSecrets?: boolean;
}

/**
 * Base class for log-streaming destinations (webhook, sentry, syslog).
 *
 * A destination holds its canonical options, decides which events it is
 * subscribed to, and performs the actual delivery in `sendTo()`. Delivery
 * errors are always contained here (logged, reported as `false`) so that a
 * failing destination can never break `MessageEventBus.send()`.
 *
 * Deliveries run through a bounded serial queue (one in flight per
 * destination); when the queue is full, the delivery is reported as failed and
 * the message stays unconfirmed for the bus's retry loop. `close()` stops
 * admission first, waits (bounded) for in-flight deliveries, then releases the
 * transport. When `circuitBreaker.maxFailures` is configured, a breaker skips
 * deliveries to a persistently failing endpoint; see `DeliveryCircuitBreaker`.
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

	private readonly deliveryQueue = new BoundedDeliveryQueue(MAX_QUEUED_DELIVERIES);

	private readonly deliveryBreaker?: DeliveryCircuitBreaker;

	private isClosed = false;

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
		if (options.circuitBreaker?.maxFailures) {
			this.deliveryBreaker = new DeliveryCircuitBreaker({
				maxFailures: options.circuitBreaker.maxFailures,
				openDurationMs: options.circuitBreaker.maxDuration,
				halfOpenRequests: options.circuitBreaker.halfOpenRequests,
				failureWindowMs: options.circuitBreaker.failureWindow,
			});
		}
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
		if (this.isClosed) return false;

		if (this.deliveryBreaker && !this.deliveryBreaker.allowRequest()) {
			this.logger.debug(
				`Circuit breaker open for log streaming destination "${this.label}" — skipping delivery`,
			);
			return false;
		}

		const queued = this.deliveryQueue.enqueue(async () => await this.sendTo(msg));
		if (!queued) {
			// queue overflow is backpressure, not an endpoint failure — don't feed the breaker
			this.logger.warn(
				`Delivery queue full for log streaming destination "${this.label}" — message left for retry`,
			);
			return false;
		}

		try {
			const delivered = await queued;
			this.deliveryBreaker?.record(delivered);
			return delivered;
		} catch (error) {
			this.deliveryBreaker?.record(false);
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

	/**
	 * Canonical internal options, including the discriminator and id.
	 * Pass `redactSecrets` when the result is handed to a read API; persistence
	 * and internal reload must use the full (unredacted) serialization.
	 */
	serialize(_options?: SerializeOptions): MessageEventBusDestinationOptions {
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

	/**
	 * Stop admitting deliveries, wait (bounded) for in-flight ones, then release
	 * transport resources. Safe to call multiple times.
	 */
	async close(): Promise<void> {
		this.isClosed = true;
		await this.deliveryQueue.drain(CLOSE_DRAIN_TIMEOUT_MS);
		await this.closeTransport();
	}

	/** Release any transport resources. Called after in-flight deliveries drained. */
	protected async closeTransport(): Promise<void> {}
}
