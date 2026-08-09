import type { HttpRequestClient, OutboundHttp } from '@n8n/backend-network';
import type { MessageEventBusDestinationSentryOptions } from 'n8n-workflow';
import {
	defaultMessageEventBusDestinationSentryOptions,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';
import { randomUUID } from 'node:crypto';

import { N8N_VERSION } from '@/constants';
import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { MessageEventBusDestination, type SerializeOptions } from './message-event-bus-destination';

/**
 * Ships events to a Sentry project by POSTing envelopes to the DSN's envelope
 * endpoint (the public Sentry ingestion protocol) through the instance's
 * `OutboundHttp`, instead of configuring the global Sentry SDK — a destination
 * must not interfere with the instance's own error reporting.
 */
export class MessageEventBusDestinationSentry extends MessageEventBusDestination {
	readonly __type = MessageEventBusDestinationTypeNames.sentry;

	dsn: string;

	tracesSampleRate?: number;

	sendPayload: boolean;

	private readonly httpClient: HttpRequestClient;

	constructor(
		eventBus: MessageEventBus,
		outboundHttp: OutboundHttp,
		options: MessageEventBusDestinationSentryOptions,
	) {
		super(eventBus, { ...defaultMessageEventBusDestinationSentryOptions, ...options });
		this.dsn = options.dsn;
		this.tracesSampleRate = options.tracesSampleRate;
		this.sendPayload = options.sendPayload ?? true;
		this.httpClient = outboundHttp.requests();
	}

	/** DSN `https://<publicKey>@<host>/<projectId>` → envelope ingestion endpoint. */
	private envelopeEndpoint(): { url: string; qs: Record<string, string> } {
		const dsn = new URL(this.dsn);
		const projectId = dsn.pathname.replace(/\/$/, '').split('/').pop() ?? '';
		return {
			url: `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`,
			qs: { sentry_key: dsn.username, sentry_version: '7' },
		};
	}

	protected async sendTo(msg: EventMessageTypes): Promise<boolean> {
		const { url, qs } = this.envelopeEndpoint();
		const serialized = this.payloadFor(msg);

		const eventId = randomUUID().replace(/-/g, '');
		const timestamp = new Date().toISOString();
		const level = /\.(failed|error|crashed)$/.test(msg.eventName) ? 'error' : 'info';

		const envelopeHeader = { event_id: eventId, sent_at: timestamp };
		const itemHeader = { type: 'event' };
		const event = {
			event_id: eventId,
			timestamp,
			platform: 'node',
			level,
			logger: 'n8n',
			release: `n8n@${N8N_VERSION}`,
			message: msg.eventName,
			extra: this.sendPayload ? { ...serialized } : { id: msg.id, eventName: msg.eventName },
		};

		const body = [envelopeHeader, itemHeader, event].map((part) => JSON.stringify(part)).join('\n');

		const response = await this.httpClient.request({
			url,
			method: 'POST',
			qs,
			headers: { 'Content-Type': 'application/x-sentry-envelope' },
			body,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});

		return response.statusCode >= 200 && response.statusCode < 300;
	}

	serialize(options?: SerializeOptions): MessageEventBusDestinationSentryOptions {
		return {
			...super.serialize(options),
			dsn: this.dsn,
			sendPayload: this.sendPayload,
			...(this.tracesSampleRate !== undefined ? { tracesSampleRate: this.tracesSampleRate } : {}),
		};
	}
}
