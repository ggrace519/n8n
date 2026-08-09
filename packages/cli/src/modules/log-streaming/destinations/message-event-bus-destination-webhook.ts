import type { HttpRequestClient, OutboundHttp } from '@n8n/backend-network';
import { CredentialsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { Credentials } from 'n8n-core';
import type {
	IDataObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
	MessageEventBusDestinationWebhookOptions,
	MessageEventBusDestinationWebhookParameterItem,
	MessageEventBusDestinationWebhookParameterOptions,
} from 'n8n-workflow';
import {
	defaultMessageEventBusDestinationWebhookOptions,
	jsonParse,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';

import { z } from 'zod';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { MessageEventBusDestination } from './message-event-bus-destination';

const HTTP_METHODS: IHttpRequestMethods[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

// user-specified JSON headers/query: accept only primitive-valued flat objects
const jsonParametersSchema = z.record(
	z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
);

export class MessageEventBusDestinationWebhook extends MessageEventBusDestination {
	readonly __type = MessageEventBusDestinationTypeNames.webhook;

	url: string;

	method: string;

	expectedStatusCode: number;

	responseCodeMustMatch: boolean;

	authentication: 'predefinedCredentialType' | 'genericCredentialType' | 'none';

	sendQuery: boolean;

	sendHeaders: boolean;

	genericAuthType: string;

	nodeCredentialType: string;

	specifyHeaders: string;

	specifyQuery: string;

	jsonQuery: string;

	jsonHeaders: string;

	headerParameters: MessageEventBusDestinationWebhookParameterItem;

	queryParameters: MessageEventBusDestinationWebhookParameterItem;

	sendPayload: boolean;

	options: NonNullable<MessageEventBusDestinationWebhookParameterOptions>;

	private readonly httpClient: HttpRequestClient;

	constructor(
		eventBus: MessageEventBus,
		outboundHttp: OutboundHttp,
		options: MessageEventBusDestinationWebhookOptions,
	) {
		super(eventBus, { ...defaultMessageEventBusDestinationWebhookOptions, ...options });
		const defaults = defaultMessageEventBusDestinationWebhookOptions;
		this.url = options.url;
		this.method = options.method ?? defaults.method ?? 'POST';
		this.expectedStatusCode = options.expectedStatusCode ?? defaults.expectedStatusCode ?? 200;
		this.responseCodeMustMatch = options.responseCodeMustMatch ?? false;
		this.authentication = options.authentication ?? 'none';
		this.sendQuery = options.sendQuery ?? false;
		this.sendHeaders = options.sendHeaders ?? false;
		this.genericAuthType = options.genericAuthType ?? '';
		this.nodeCredentialType = options.nodeCredentialType ?? '';
		this.specifyHeaders = options.specifyHeaders ?? '';
		this.specifyQuery = options.specifyQuery ?? '';
		this.jsonQuery = options.jsonQuery ?? '';
		this.jsonHeaders = options.jsonHeaders ?? '';
		this.headerParameters = options.headerParameters ?? { parameters: [] };
		this.queryParameters = options.queryParameters ?? { parameters: [] };
		this.sendPayload = options.sendPayload ?? true;
		this.options = options.options ?? {};
		this.httpClient = outboundHttp.requests();
	}

	private parametersToObject(item: MessageEventBusDestinationWebhookParameterItem): IDataObject {
		const result: IDataObject = {};
		for (const { name, value } of item.parameters) {
			if (name) result[name] = value ?? undefined;
		}
		return result;
	}

	private parseJsonParameters(raw: string): IDataObject {
		if (!raw) return {};
		const parsed = jsonParse<unknown>(raw, { fallbackValue: {} });
		const result = jsonParametersSchema.safeParse(parsed);
		return result.success ? result.data : {};
	}

	private buildHeaders(): IDataObject {
		if (!this.sendHeaders) return {};
		if (this.specifyHeaders === 'json') return this.parseJsonParameters(this.jsonHeaders);
		return this.parametersToObject(this.headerParameters);
	}

	private buildQuery(): IDataObject {
		if (!this.sendQuery) return {};
		if (this.specifyQuery === 'json') return this.parseJsonParameters(this.jsonQuery);
		return this.parametersToObject(this.queryParameters);
	}

	/**
	 * Resolve a generic-credential auth reference into request authentication.
	 * Supports header auth and basic auth; other generic types (and
	 * `predefinedCredentialType`) are not resolved here.
	 */
	private async applyAuthentication(
		requestOptions: IHttpRequestOptions,
		headers: IDataObject,
	): Promise<void> {
		if (this.authentication !== 'genericCredentialType' || !this.genericAuthType) return;

		const reference = this.credentials[this.genericAuthType];
		if (!reference?.id) return;

		const stored = await Container.get(CredentialsRepository).findOneBy({ id: reference.id });
		if (!stored) return;

		const decrypted = await new Credentials(
			{ id: stored.id, name: stored.name },
			stored.type,
			stored.data,
		).getData();

		if (this.genericAuthType === 'httpHeaderAuth') {
			const { name, value } = decrypted;
			if (typeof name === 'string' && name.length > 0) {
				headers[name] = typeof value === 'string' ? value : String(value ?? '');
			}
		} else if (this.genericAuthType === 'httpBasicAuth') {
			const { user, password } = decrypted;
			requestOptions.auth = {
				username: typeof user === 'string' ? user : String(user ?? ''),
				password: typeof password === 'string' ? password : String(password ?? ''),
			};
		}
	}

	protected async sendTo(msg: EventMessageTypes): Promise<boolean> {
		const method = HTTP_METHODS.find((candidate) => candidate === this.method.toUpperCase());
		const headers = this.buildHeaders();
		const serialized = this.payloadFor(msg);
		if (!this.sendPayload) delete serialized.payload;

		const requestOptions: IHttpRequestOptions = {
			url: this.url,
			method: method ?? 'POST',
			headers,
			qs: this.buildQuery(),
			body: serialized,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			...(this.options.timeout ? { timeout: this.options.timeout } : {}),
			...(this.options.allowUnauthorizedCerts ? { skipSslCertificateValidation: true } : {}),
			...(this.options.queryParameterArrays
				? { arrayFormat: this.options.queryParameterArrays }
				: {}),
			...(this.options.redirect?.redirect?.followRedirects === false
				? { disableFollowRedirect: true }
				: {}),
			...(this.options.redirect?.redirect?.maxRedirects
				? { maxRedirects: this.options.redirect.redirect.maxRedirects }
				: {}),
		};

		await this.applyAuthentication(requestOptions, headers);

		const response = await this.httpClient.request({ ...requestOptions, returnFullResponse: true });

		if (this.responseCodeMustMatch) return response.statusCode === this.expectedStatusCode;
		return response.statusCode >= 200 && response.statusCode < 300;
	}

	serialize(): MessageEventBusDestinationWebhookOptions {
		return {
			...super.serialize(),
			url: this.url,
			method: this.method,
			expectedStatusCode: this.expectedStatusCode,
			responseCodeMustMatch: this.responseCodeMustMatch,
			authentication: this.authentication,
			sendQuery: this.sendQuery,
			sendHeaders: this.sendHeaders,
			genericAuthType: this.genericAuthType,
			nodeCredentialType: this.nodeCredentialType,
			specifyHeaders: this.specifyHeaders,
			specifyQuery: this.specifyQuery,
			jsonQuery: this.jsonQuery,
			jsonHeaders: this.jsonHeaders,
			headerParameters: this.headerParameters,
			queryParameters: this.queryParameters,
			sendPayload: this.sendPayload,
			options: this.options,
		};
	}
}
