import type { User } from '@n8n/db';
import type {
	MessageEventBusDestinationSyslogOptions,
	MessageEventBusDestinationWebhookOptions,
} from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';

import { validateDestinationCredentials } from '../validate-destination-credentials';

const user = mock<User>({ id: 'user-1' });
const credentialsFinder = mock<CredentialsFinderService>();

const webhookOptions = (
	overrides: Partial<MessageEventBusDestinationWebhookOptions> = {},
): MessageEventBusDestinationWebhookOptions => ({
	__type: MessageEventBusDestinationTypeNames.webhook,
	id: 'wh-1',
	url: 'http://localhost:3456',
	...overrides,
});

describe('validateDestinationCredentials', () => {
	beforeEach(() => {
		credentialsFinder.findCredentialForUser.mockReset();
	});

	it('strips stray credential references from non-webhook destinations', async () => {
		const syslogOptions: MessageEventBusDestinationSyslogOptions = {
			__type: MessageEventBusDestinationTypeNames.syslog,
			host: 'localhost',
			credentials: { httpHeaderAuth: { id: 'cred-1', name: 'sneaky' } },
		};
		const result = await validateDestinationCredentials(syslogOptions, user, credentialsFinder);
		expect(result.credentials).toEqual({});
		expect(credentialsFinder.findCredentialForUser).not.toHaveBeenCalled();
	});

	it('strips stray credential references when authentication is none', async () => {
		const result = await validateDestinationCredentials(
			webhookOptions({ credentials: { httpHeaderAuth: { id: 'cred-1', name: 'sneaky' } } }),
			user,
			credentialsFinder,
		);
		expect(result.credentials).toEqual({});
		expect(credentialsFinder.findCredentialForUser).not.toHaveBeenCalled();
	});

	it('rejects predefinedCredentialType authentication', async () => {
		await expect(
			validateDestinationCredentials(
				webhookOptions({ authentication: 'predefinedCredentialType' }),
				user,
				credentialsFinder,
			),
		).rejects.toThrow(BadRequestError);
	});

	it('rejects an unsupported generic auth type', async () => {
		await expect(
			validateDestinationCredentials(
				webhookOptions({ authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' }),
				user,
				credentialsFinder,
			),
		).rejects.toThrow(BadRequestError);
	});

	it('rejects generic auth without a bound credential', async () => {
		await expect(
			validateDestinationCredentials(
				webhookOptions({
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
					credentials: {},
				}),
				user,
				credentialsFinder,
			),
		).rejects.toThrow(BadRequestError);
	});

	it('rejects a credential the user cannot read', async () => {
		credentialsFinder.findCredentialForUser.mockResolvedValue(null);
		await expect(
			validateDestinationCredentials(
				webhookOptions({
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
					credentials: { httpHeaderAuth: { id: 'cred-1', name: 'someone elses' } },
				}),
				user,
				credentialsFinder,
			),
		).rejects.toThrow(ForbiddenError);
		expect(credentialsFinder.findCredentialForUser).toHaveBeenCalledWith('cred-1', user, [
			'credential:read',
		]);
	});

	it('rejects a credential whose stored type does not match the auth type', async () => {
		credentialsFinder.findCredentialForUser.mockResolvedValue(
			mock({ id: 'cred-1', name: 'basic', type: 'httpBasicAuth' }),
		);
		await expect(
			validateDestinationCredentials(
				webhookOptions({
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
					credentials: { httpHeaderAuth: { id: 'cred-1', name: 'basic' } },
				}),
				user,
				credentialsFinder,
			),
		).rejects.toThrow(BadRequestError);
	});

	it('persists only the validated binding for an accessible, type-matching credential', async () => {
		credentialsFinder.findCredentialForUser.mockResolvedValue(
			mock({ id: 'cred-1', name: 'header auth', type: 'httpHeaderAuth' }),
		);
		const result = await validateDestinationCredentials(
			webhookOptions({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: {
					httpHeaderAuth: { id: 'cred-1', name: 'stale label' },
					somethingElse: { id: 'cred-2', name: 'stray' },
				},
			}),
			user,
			credentialsFinder,
		);
		expect(result.credentials).toEqual({
			httpHeaderAuth: { id: 'cred-1', name: 'header auth' },
		});
	});
});
