import { Container } from '@n8n/di';

import { DynamicCredentialsConfig } from '../dynamic-credentials.config';

/**
 * Clean-room test: only `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN` survived
 * as a pinned name (Playwright config). The two CORS variable names are a
 * decision made here — this test is what pins them from now on.
 */
describe('DynamicCredentialsConfig', () => {
	beforeEach(() => {
		Container.reset();
	});

	afterEach(() => {
		delete process.env.N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN;
		delete process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN;
		delete process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS;
	});

	it('defaults to no token, no allowed origin and no credentialed CORS', () => {
		const config = Container.get(DynamicCredentialsConfig);

		expect(config.endpointAuthToken).toBe('');
		expect(config.corsOrigin).toBe('');
		expect(config.corsAllowCredentials).toBe(false);
	});

	it('reads each field from its environment variable', () => {
		process.env.N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN = 'a-static-token';
		process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN = 'https://app.example.com';
		process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS = 'true';

		const config = Container.get(DynamicCredentialsConfig);

		expect(config.endpointAuthToken).toBe('a-static-token');
		expect(config.corsOrigin).toBe('https://app.example.com');
		expect(config.corsAllowCredentials).toBe(true);
	});
});
