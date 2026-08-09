import type { SyslogClient } from '@n8n/syslog-client';
import { createClient, Facility, Severity, Transport } from '@n8n/syslog-client';
import type { MessageEventBusDestinationSyslogOptions } from 'n8n-workflow';
import {
	defaultMessageEventBusDestinationSyslogOptions,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { MessageEventBusDestination } from './message-event-bus-destination';

const TRANSPORT_BY_PROTOCOL: Record<'udp' | 'tcp' | 'tls', Transport> = {
	udp: Transport.Udp,
	tcp: Transport.Tcp,
	tls: Transport.Tls,
};

export class MessageEventBusDestinationSyslog extends MessageEventBusDestination {
	readonly __type = MessageEventBusDestinationTypeNames.syslog;

	host: string;

	port: number;

	protocol: 'udp' | 'tcp' | 'tls';

	facility: number;

	app_name: string;

	eol: string;

	expectedStatusCode?: number;

	tlsCa?: string;

	private client?: SyslogClient;

	constructor(eventBus: MessageEventBus, options: MessageEventBusDestinationSyslogOptions) {
		super(eventBus, { ...defaultMessageEventBusDestinationSyslogOptions, ...options });
		const defaults = defaultMessageEventBusDestinationSyslogOptions;
		this.host = options.host ?? defaults.host;
		this.port = options.port ?? defaults.port ?? 514;
		this.protocol = options.protocol ?? defaults.protocol ?? 'tcp';
		this.facility = options.facility ?? defaults.facility ?? 16;
		this.app_name = options.app_name ?? defaults.app_name ?? 'n8n';
		this.eol = options.eol ?? defaults.eol ?? '\n';
		this.expectedStatusCode = options.expectedStatusCode ?? defaults.expectedStatusCode;
		this.tlsCa = options.tlsCa;
	}

	private getClient(): SyslogClient {
		if (!this.client) {
			// the client validates facility against its enum, which has gaps (12, 15)
			const validFacilities = Object.values(Facility).filter(
				(value): value is Facility => typeof value === 'number',
			);
			const facility = validFacilities.includes(this.facility) ? this.facility : Facility.Local0;
			this.client = createClient(this.host, {
				port: this.port,
				transport: TRANSPORT_BY_PROTOCOL[this.protocol],
				facility,
				severity: Severity.Informational,
				appName: this.app_name.substring(0, 48),
				...(this.protocol === 'tls' && this.tlsCa ? { tlsCA: this.tlsCa } : {}),
			});
			// `log()` rejections carry the failure; the parallel EventEmitter
			// 'error' event only needs a listener so it cannot crash the process.
			this.client.on('error', (error: Error) => {
				this.logger.debug(`Syslog client error for destination "${this.label}": ${error.message}`);
			});
		}
		return this.client;
	}

	protected async sendTo(msg: EventMessageTypes): Promise<boolean> {
		const line = JSON.stringify(this.payloadFor(msg)) + (this.eol === '\n' ? '' : this.eol);
		await this.getClient().log(line, { msgid: msg.id.substring(0, 32) });
		return true;
	}

	async close(): Promise<void> {
		this.client?.close();
		this.client = undefined;
	}

	serialize(): MessageEventBusDestinationSyslogOptions {
		return {
			...super.serialize(),
			host: this.host,
			port: this.port,
			protocol: this.protocol,
			facility: this.facility,
			app_name: this.app_name,
			eol: this.eol,
			...(this.expectedStatusCode !== undefined
				? { expectedStatusCode: this.expectedStatusCode }
				: {}),
			...(this.tlsCa !== undefined ? { tlsCa: this.tlsCa } : {}),
		};
	}
}
