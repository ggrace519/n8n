import { Container } from '@n8n/di';

import { setSamlLoginEnabled } from '@/modules/sso-saml/saml-helpers';
import { SamlService } from '@/modules/sso-saml/saml.service';

import { sampleConfig } from './sample-metadata';
import { createOwner } from '../shared/db/users';
import type { SuperAgentTest } from '../shared/types';
import * as utils from '../shared/utils/';

const testServer = utils.setupTestServer({
	endpointGroups: ['saml'],
	enabledFeatures: ['feat:saml'],
});

let authOwnerAgent: SuperAgentTest;

beforeAll(async () => {
	const owner = await createOwner();
	authOwnerAgent = testServer.authAgentFor(owner);
	await authOwnerAgent.post('/sso/saml/config').send(sampleConfig).expect(200);
	await setSamlLoginEnabled(true);
});

afterAll(async () => {
	await setSamlLoginEnabled(false);
	await Container.get(SamlService).reset();
});

describe('GET /sso/saml/initsso', () => {
	test('returns the identity provider login URL and sets the login flow cookie', async () => {
		const response = await testServer.authlessAgent.get('/sso/saml/initsso').expect(200);

		const loginUrl = response.body.data as string;
		expect(loginUrl.startsWith('https://')).toBe(true);
		expect(new URL(loginUrl).searchParams.get('SAMLRequest')).toBeTruthy();

		const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
		expect(cookies?.join(';')).toContain('n8n-saml-flow=');
	});

	test('issues a different flow identifier for every login start', async () => {
		const readFlowCookie = async () => {
			const response = await testServer.authlessAgent.get('/sso/saml/initsso').expect(200);
			const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
			return cookies.find((cookie) => cookie.startsWith('n8n-saml-flow='));
		};

		const first = await readFlowCookie();
		const second = await readFlowCookie();

		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(first).not.toBe(second);
	});
});
