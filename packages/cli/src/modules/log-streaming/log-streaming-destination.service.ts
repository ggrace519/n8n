import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { Service } from '@n8n/di';
import type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationWebhookOptions,
} from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { EventMessageConfirmSource } from '@/eventbus/event-message-classes/event-message-confirm';
import {
	EventMessageGeneric,
	eventMessageGenericDestinationTestEvent,
} from '@/eventbus/event-message-classes/event-message-generic';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { REDACTED_SECRET_VALUE } from './constants';
import { createMessageEventBusDestination } from './create-message-event-bus-destination';
import { EventDestinationsRepository } from './database/repositories/event-destination.repository';
import type { MessageEventBusDestination } from './destinations/message-event-bus-destination';

type ConfirmCallback = (message: EventMessageTypes, source: EventMessageConfirmSource) => void;

type DeliveryStatus = 'pending' | 'delivered';

interface MessageDeliveryState {
	statuses: Map<string, DeliveryStatus>;
	updatedAt: number;
}

/** Delivery state is pruned once it can no longer drive a retry decision. */
const DELIVERY_STATE_TTL_MS = 30 * 60 * 1000;
/** Sweep expired entries once the map grows past this size. */
const DELIVERY_STATE_SWEEP_THRESHOLD = 1000;
/** Hard cap; beyond it the stalest entries are dropped (their deliveries may repeat). */
const DELIVERY_STATE_MAX_ENTRIES = 5000;

/**
 * Owns the registry of active log-streaming destinations.
 *
 * Delivery design: this service installs a single `"message"` listener on the
 * `MessageEventBus` and fans each event out to every enabled, subscribed
 * destination.
 *
 * Confirmation policy: the bus's event log treats the first confirmation as
 * "message sent", so the message is confirmed only once EVERY applicable
 * destination has delivered it. Per-(message, destination) delivery state is
 * kept in memory so that a bus retry re-attempts only the destinations that
 * have not delivered yet — no lost retries for the failed destination, no
 * duplicate sends to the succeeded one. The state map is bounded (TTL sweep +
 * hard cap, see constants above); an entry evicted by the hard cap can at
 * worst cause a duplicate delivery on a later retry, never a lost one.
 */
@Service()
export class LogStreamingDestinationService {
	private readonly destinations = new Map<string, MessageEventBusDestination>();

	private readonly deliveryState = new Map<string, MessageDeliveryState>();

	private readonly mutationLocks = new Map<string, Promise<unknown>>();

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
			this.deliveryState.delete(msg.id);
			return;
		}

		this.pruneDeliveryState();

		const tracked = this.deliveryState.get(msg.id);
		const state: MessageDeliveryState = tracked ?? { statuses: new Map(), updatedAt: Date.now() };
		if (!tracked) this.deliveryState.set(msg.id, state);
		state.updatedAt = Date.now();

		// a bus retry only re-attempts destinations that have neither delivered
		// nor still have a delivery in flight from an earlier attempt
		const outstanding = applicable.filter(
			(destination) => state.statuses.get(destination.id) === undefined,
		);
		for (const destination of outstanding) state.statuses.set(destination.id, 'pending');

		await Promise.all(
			outstanding.map(async (destination) => {
				const delivered = await destination.receiveFromEventBus(msg);
				if (delivered) state.statuses.set(destination.id, 'delivered');
				else state.statuses.delete(destination.id);
				state.updatedAt = Date.now();
			}),
		);

		const allDelivered = applicable.every(
			(destination) => state.statuses.get(destination.id) === 'delivered',
		);
		if (allDelivered) {
			for (const destination of applicable) {
				confirmCallback(msg, { id: destination.id, name: destination.label });
			}
			this.deliveryState.delete(msg.id);
		}
	}

	private pruneDeliveryState(now = Date.now()): void {
		if (this.deliveryState.size < DELIVERY_STATE_SWEEP_THRESHOLD) return;
		for (const [id, state] of this.deliveryState) {
			if (now - state.updatedAt > DELIVERY_STATE_TTL_MS) this.deliveryState.delete(id);
		}
		if (this.deliveryState.size <= DELIVERY_STATE_MAX_ENTRIES) return;
		const byAge = [...this.deliveryState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		for (const [id] of byAge.slice(0, this.deliveryState.size - DELIVERY_STATE_MAX_ENTRIES)) {
			this.deliveryState.delete(id);
		}
	}

	/** Serialize per-id mutations so concurrent add/remove cannot interleave. */
	private async withMutationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.mutationLocks.get(id) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.mutationLocks.set(id, tail);
		void tail.then(() => {
			if (this.mutationLocks.get(id) === tail) this.mutationLocks.delete(id);
		});
		return await run;
	}

	/**
	 * All active destinations as serialized options; with an id,
	 * zero or one matches in an array. Secret-bearing option values are
	 * redacted by default — read APIs must never echo stored secrets. Internal
	 * callers that need the full options must opt out explicitly.
	 */
	async findDestination(
		id?: string,
		{ redactSecrets = true }: { redactSecrets?: boolean } = {},
	): Promise<MessageEventBusDestinationOptions[]> {
		const serializeOptions = { redactSecrets };
		if (id !== undefined) {
			const destination = this.destinations.get(id);
			return destination ? [destination.serialize(serializeOptions)] : [];
		}
		return [...this.destinations.values()].map((destination) =>
			destination.serialize(serializeOptions),
		);
	}

	/**
	 * Re-saving options that were read from a redacted API response must not
	 * overwrite stored secrets with the redaction placeholder: placeholder
	 * values are restored from the currently active destination with the same
	 * id before the options are used to build the replacement.
	 */
	restoreRedactedSecrets(
		options: MessageEventBusDestinationOptions,
	): MessageEventBusDestinationOptions {
		if (
			options.__type !== MessageEventBusDestinationTypeNames.webhook ||
			!options.id ||
			!this.destinations.has(options.id)
		) {
			return options;
		}
		const stored = this.destinations.get(options.id)?.serialize();
		if (stored?.__type !== MessageEventBusDestinationTypeNames.webhook) return options;

		const incoming = options as MessageEventBusDestinationWebhookOptions;
		const existing = stored as MessageEventBusDestinationWebhookOptions;

		const restoreParameters = (
			incomingItem: MessageEventBusDestinationWebhookOptions['headerParameters'],
			existingItem: MessageEventBusDestinationWebhookOptions['headerParameters'],
		) => {
			if (!incomingItem?.parameters) return incomingItem;
			const existingByName = new Map(
				(existingItem?.parameters ?? []).map(({ name, value }) => [name, value]),
			);
			return {
				parameters: incomingItem.parameters.map(({ name, value }) => ({
					name,
					value:
						value === REDACTED_SECRET_VALUE && existingByName.has(name)
							? (existingByName.get(name) ?? null)
							: value,
				})),
			};
		};

		const restored: MessageEventBusDestinationWebhookOptions = {
			...incoming,
			jsonHeaders:
				incoming.jsonHeaders === REDACTED_SECRET_VALUE
					? existing.jsonHeaders
					: incoming.jsonHeaders,
			jsonQuery:
				incoming.jsonQuery === REDACTED_SECRET_VALUE ? existing.jsonQuery : incoming.jsonQuery,
			headerParameters: restoreParameters(incoming.headerParameters, existing.headerParameters),
			queryParameters: restoreParameters(incoming.queryParameters, existing.queryParameters),
		};
		return restored;
	}

	/**
	 * Persist and activate a destination. The row is persisted first; runtime
	 * state is swapped only after persistence succeeds, so a DB failure leaves
	 * the previously active destination untouched. An existing destination with
	 * the same id is fully replaced (its transport resources are closed).
	 */
	async addDestination(
		destination: MessageEventBusDestination,
	): Promise<MessageEventBusDestination> {
		return await this.withMutationLock(destination.id, async () => {
			await this.repository.saveDestination(destination.id, destination.serialize());

			const existing = this.destinations.get(destination.id);
			this.destinations.set(destination.id, destination);
			if (existing && existing !== destination) await existing.close();
			return destination;
		});
	}

	/**
	 * Deactivate a destination and close its transport resources. Unless
	 * `persist` is `false`, the stored row is deleted as well — the row is
	 * removed first so a DB failure cannot leave a deleted-but-still-streaming
	 * destination behind.
	 */
	async removeDestination(id: string, persist: boolean = true): Promise<void> {
		await this.withMutationLock(id, async () => {
			if (persist) await this.repository.deleteById(id);

			const destination = this.destinations.get(id);
			if (destination) {
				this.destinations.delete(id);
				await destination.close();
			}
		});
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

	/**
	 * Stop listening (no new deliveries are admitted), then close every
	 * destination — each close drains its in-flight deliveries (bounded)
	 * before releasing the transport.
	 */
	async shutdown(): Promise<void> {
		this.eventBus.removeListener('message', this.messageListener);
		await Promise.all([...this.destinations.values()].map(async (d) => await d.close()));
		this.destinations.clear();
		this.deliveryState.clear();
		this.isInitialized = false;
	}
}
