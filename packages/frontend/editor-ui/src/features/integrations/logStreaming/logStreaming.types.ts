import type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';

export type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationWebhookOptions,
	MessageEventBusDestinationSentryOptions,
	MessageEventBusDestinationSyslogOptions,
} from 'n8n-workflow';

/** The concrete (non-abstract) destination types the UI can create and edit. */
export type MessageEventBusDestinationType =
	| MessageEventBusDestinationTypeNames.webhook
	| MessageEventBusDestinationTypeNames.sentry
	| MessageEventBusDestinationTypeNames.syslog;

/** A group of subscribable events, keyed by its shared name prefix. */
export interface EventGroup {
	name: string;
	events: string[];
}

/** Data passed to the destination settings modal when it is opened. */
export interface EventDestinationSettingsModalData {
	destination: MessageEventBusDestinationOptions;
	isNew: boolean;
}
