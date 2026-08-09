import { Logger } from '@n8n/backend-common';
import type { HttpRequestClient, OutboundHttp } from '@n8n/backend-network';
import { mockInstance } from '@n8n/backend-test-utils';
import { CredentialsRepository } from '@n8n/db';
import type { MessageEventBusDestinationWebhookOptions } from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { EventMessageGeneric } from '@/eventbus/event-message-classes/event-message-generic';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { REDACTED_SECRET_VALUE } from '../constants';
import { MessageEventBusDestinationWebhook } from '../destinations/message-event-bus-destination-webhook';

vi.mock('n8n-core', async (importOriginal) => {
	const original = await importOriginal<typeof import('n8n-core')>();
	return {
		...original,
		Credentials: class {
			async getData() {
				return { name: 'X-Auth', value: 'decrypted-token' };
			}
		},
	};
});

mockInstance(Logger);
const credentialsRepository = mockInstance(CredentialsRepository);

const eventBus = mock<MessageEventBus>();
const httpClient = mock<HttpRequestClient>();
const outboundHttp = mock<OutboundHttp>();
outboundHttp.requests.mockReturnValue(httpClient);

const baseOptions: MessageEventBusDestinationWebhookOptions = {
	__type: MessageEventBusDestinationTypeNames.webhook,
	id: 'wh-1',
	label: 'Webhook under test',
	url: 'http://localhost:3456/hook',
};

const message = new EventMessageGeneric({ eventName: 'n8n.workflow.success' });

const createDestination = (overrides: Partial<MessageEventBusDestinationWebhookOptions> = {}) =>
	new MessageEventBusDestinationWebhook(eventBus, outboundHttp, { ...baseOptions, ...overrides });

describe('MessageEventBusDestinationWebhook', () => {
	beforeEach(() => {
		httpClient.request.mockReset();
		httpClient.request.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
		credentialsRepository.findOneBy.mockReset();
	});

	describe('delivery authentication (fail-closed)', () => {
		it('delivers without authentication when none is configured', async () => {
			const destination = createDestination({ authentication: 'none' });
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(true);
			expect(httpClient.request).toHaveBeenCalledTimes(1);
		});

		it('fails the delivery for predefinedCredentialType instead of sending unauthenticated', async () => {
			const destination = createDestination({
				authentication: 'predefinedCredentialType',
				nodeCredentialType: 'someApi',
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(false);
			expect(httpClient.request).not.toHaveBeenCalled();
		});

		it('fails the delivery for an unsupported generic auth type', async () => {
			const destination = createDestination({
				authentication: 'genericCredentialType',
				genericAuthType: 'oAuth2Api',
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(false);
			expect(httpClient.request).not.toHaveBeenCalled();
		});

		it('fails the delivery when no credential is bound', async () => {
			const destination = createDestination({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: {},
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(false);
			expect(httpClient.request).not.toHaveBeenCalled();
		});

		it('fails the delivery when the bound credential no longer exists', async () => {
			credentialsRepository.findOneBy.mockResolvedValue(null);
			const destination = createDestination({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: { httpHeaderAuth: { id: 'cred-1', name: 'header auth' } },
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(false);
			expect(httpClient.request).not.toHaveBeenCalled();
		});

		it('fails the delivery when the stored credential type does not match', async () => {
			credentialsRepository.findOneBy.mockResolvedValue(
				mock({ id: 'cred-1', name: 'not header auth', type: 'httpBasicAuth', data: '' }),
			);
			const destination = createDestination({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: { httpHeaderAuth: { id: 'cred-1', name: 'header auth' } },
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(false);
			expect(httpClient.request).not.toHaveBeenCalled();
		});

		it('applies header auth from a resolvable, type-matching credential', async () => {
			credentialsRepository.findOneBy.mockResolvedValue(
				mock({ id: 'cred-1', name: 'header auth', type: 'httpHeaderAuth', data: 'enc' }),
			);
			const destination = createDestination({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: { httpHeaderAuth: { id: 'cred-1', name: 'header auth' } },
			});
			await expect(destination.receiveFromEventBus(message)).resolves.toBe(true);
			expect(httpClient.request).toHaveBeenCalledWith(
				expect.objectContaining({
					headers: expect.objectContaining({ 'X-Auth': 'decrypted-token' }),
				}),
			);
		});
	});

	describe('serialize', () => {
		const secretOptions: Partial<MessageEventBusDestinationWebhookOptions> = {
			sendHeaders: true,
			specifyHeaders: 'keypair',
			headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer secret' }] },
			sendQuery: true,
			specifyQuery: 'keypair',
			queryParameters: { parameters: [{ name: 'api_key', value: 'qsecret' }] },
			jsonHeaders: '{"Authorization":"Bearer secret"}',
			jsonQuery: '{"api_key":"qsecret"}',
		};

		it('returns full values without the redaction flag (persistence/internal reload)', () => {
			const serialized = createDestination(secretOptions).serialize();
			expect(serialized.headerParameters?.parameters[0].value).toBe('Bearer secret');
			expect(serialized.queryParameters?.parameters[0].value).toBe('qsecret');
			expect(serialized.jsonHeaders).toBe('{"Authorization":"Bearer secret"}');
			expect(serialized.jsonQuery).toBe('{"api_key":"qsecret"}');
		});

		it('redacts header/query values and raw JSON strings for read APIs', () => {
			const serialized = createDestination(secretOptions).serialize({ redactSecrets: true });
			expect(serialized.headerParameters?.parameters[0]).toEqual({
				name: 'Authorization',
				value: REDACTED_SECRET_VALUE,
			});
			expect(serialized.queryParameters?.parameters[0]).toEqual({
				name: 'api_key',
				value: REDACTED_SECRET_VALUE,
			});
			expect(serialized.jsonHeaders).toBe(REDACTED_SECRET_VALUE);
			expect(serialized.jsonQuery).toBe(REDACTED_SECRET_VALUE);
			// non-secret fields remain readable
			expect(serialized.url).toBe('http://localhost:3456/hook');
			expect(serialized.label).toBe('Webhook under test');
		});

		it('keeps empty values empty when redacting', () => {
			const serialized = createDestination().serialize({ redactSecrets: true });
			expect(serialized.jsonHeaders).toBe('');
			expect(serialized.jsonQuery).toBe('');
			expect(serialized.headerParameters).toEqual({ parameters: [] });
		});
	});
});
