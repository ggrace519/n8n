import type { OutboundHttp } from '@n8n/backend-network';
import type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationSentryOptions,
	MessageEventBusDestinationSyslogOptions,
	MessageEventBusDestinationWebhookOptions,
} from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames, UserError } from 'n8n-workflow';

import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { MessageEventBusDestinationSentry } from './destinations/message-event-bus-destination-sentry';
import { MessageEventBusDestinationSyslog } from './destinations/message-event-bus-destination-syslog';
import { MessageEventBusDestinationWebhook } from './destinations/message-event-bus-destination-webhook';
import type { MessageEventBusDestination } from './destinations/message-event-bus-destination';

function isWebhookOptions(
	options: MessageEventBusDestinationOptions,
): options is MessageEventBusDestinationWebhookOptions {
	return options.__type === MessageEventBusDestinationTypeNames.webhook;
}

function isSentryOptions(
	options: MessageEventBusDestinationOptions,
): options is MessageEventBusDestinationSentryOptions {
	return options.__type === MessageEventBusDestinationTypeNames.sentry;
}

function isSyslogOptions(
	options: MessageEventBusDestinationOptions,
): options is MessageEventBusDestinationSyslogOptions {
	return options.__type === MessageEventBusDestinationTypeNames.syslog;
}

/**
 * Instantiate a concrete destination from its serialized options,
 * dispatching on the `__type` discriminator.
 */
export function createMessageEventBusDestination(
	eventBus: MessageEventBus,
	outboundHttp: OutboundHttp,
	options: MessageEventBusDestinationOptions,
): MessageEventBusDestination {
	if (isWebhookOptions(options)) {
		return new MessageEventBusDestinationWebhook(eventBus, outboundHttp, options);
	}
	if (isSentryOptions(options)) {
		return new MessageEventBusDestinationSentry(eventBus, outboundHttp, options);
	}
	if (isSyslogOptions(options)) {
		return new MessageEventBusDestinationSyslog(eventBus, options);
	}
	throw new UserError(`Unknown message event bus destination type: ${options.__type ?? 'none'}`);
}
