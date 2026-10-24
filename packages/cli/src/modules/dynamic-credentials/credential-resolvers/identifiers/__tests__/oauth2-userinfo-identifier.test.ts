import { mock } from 'vitest-mock-extended';
import type { Logger } from '@n8n/backend-common';
import type { HttpRequestClient, OutboundHttp, SsrfProtectionService } from '@n8n/backend-network';
import type { SsrfProtectionConfig } from '@n8n/config';

import { CredentialResolutionError } from '../../../errors/credential-resolution.error';
import {
	OAUTH2_RESOLVER_TYPE,
	OAUTH2_USERINFO_VALIDATION,
	OAuth2UserinfoIdentifier,
} from '../oauth2-userinfo-identifier';

const METADATA_URI = 'https://idp.example.com/.well-known/openid-configuration';
const USERINFO = 'https://idp.example.com/userinfo';
const config = { metadataUri: METADATA_URI, validation: OAUTH2_USERINFO_VALIDATION };

type RequestArgs = { url: string; headers?: Record<string, string> };

/** The SSRF-guarded client returns the parsed body, and throws on a non-2xx answer. */
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('OAuth2UserinfoIdentifier', () => {
	let request: ReturnType<typeof vi.fn>;
	let identifier: OAuth2UserinfoIdentifier;
	const respond = (
		userinfo: () => unknown,
		discovery: () => unknown = () => ({ userinfo_endpoint: USERINFO }),
	) =>
		request.mockImplementation(async ({ url }: RequestArgs) =>
			url === METADATA_URI ? discovery() : userinfo(),
		);
	const callsTo = (url: string) =>
		request.mock.calls.filter(([args]: [RequestArgs]) => args.url === url);

	beforeEach(() => {
		request = vi.fn();
		respond(() => ({ sub: 'user-123' }));
		const outboundHttp = mock<OutboundHttp>();
		outboundHttp.requests.mockReturnValue({ request } as unknown as HttpRequestClient);
		identifier = new OAuth2UserinfoIdentifier(
			mock<Logger>(),
			outboundHttp,
			mock<SsrfProtectionService>(),
			mock<SsrfProtectionConfig>({ enabled: false }),
		);
	});

	describe('supports', () => {
		it('accepts only the oauth2 resolver type with userinfo validation and a metadata URI', () => {
			expect(OAuth2UserinfoIdentifier.supports(OAUTH2_RESOLVER_TYPE, config)).toBe(true);
			expect(OAuth2UserinfoIdentifier.supports('n8n', config)).toBe(false);
			expect(
				OAuth2UserinfoIdentifier.supports(OAUTH2_RESOLVER_TYPE, { metadataUri: METADATA_URI }),
			).toBe(false);
			expect(
				OAuth2UserinfoIdentifier.supports(OAUTH2_RESOLVER_TYPE, {
					validation: OAUTH2_USERINFO_VALIDATION,
				}),
			).toBe(false);
		});
	});

	it('identifies the user by the UserInfo sub claim, presenting the Bearer token', async () => {
		await expect(identifier.resolve('Bearer access-token', config)).resolves.toBe('user-123');

		expect(callsTo(USERINFO)[0][0].headers).toMatchObject({ Authorization: 'Bearer access-token' });
	});

	it('accepts the bare token the OAuth callback passes after stripping the prefix', async () => {
		await expect(identifier.resolve('access-token', config)).resolves.toBe('user-123');
	});

	it('caches the discovery document across calls', async () => {
		await identifier.resolve('Bearer a', config);
		await identifier.resolve('Bearer b', config);

		expect(callsTo(METADATA_URI)).toHaveLength(1);
	});

	it('refuses a token the provider rejects', async () => {
		respond(() => {
			throw httpError(401);
		});

		await expect(identifier.resolve('Bearer forged', config)).rejects.toThrow(
			CredentialResolutionError,
		);
	});

	it('refuses a UserInfo answer without a sub claim', async () => {
		respond(() => ({ email: 'a@b.c' }));

		await expect(identifier.resolve('Bearer t', config)).rejects.toThrow(CredentialResolutionError);
	});

	it('refuses a discovery document without a userinfo_endpoint', async () => {
		respond(
			() => ({ sub: 'x' }),
			() => ({ issuer: 'x' }),
		);

		await expect(identifier.resolve('Bearer t', config)).rejects.toThrow(CredentialResolutionError);
	});

	it('refuses an empty or multi-word identity without calling the provider', async () => {
		await expect(identifier.resolve('', config)).rejects.toThrow(CredentialResolutionError);
		await expect(identifier.resolve('Basic dXNlcjpwYXNz', config)).rejects.toThrow(
			CredentialResolutionError,
		);
		expect(request).not.toHaveBeenCalled();
	});

	it('refuses a non-http(s) discovery URL before any request', async () => {
		await expect(
			identifier.resolve('Bearer t', { ...config, metadataUri: 'file:///etc/passwd' }),
		).rejects.toThrow(CredentialResolutionError);
		expect(request).not.toHaveBeenCalled();
	});

	it('refuses plain http', async () => {
		await expect(
			identifier.resolve('Bearer t', {
				...config,
				metadataUri: 'http://idp.example.com/.well-known/openid-configuration',
			}),
		).rejects.toThrow(CredentialResolutionError);
		expect(request).not.toHaveBeenCalled();
	});

	it('refuses a userinfo_endpoint on another origin than the discovery document', async () => {
		respond(
			() => ({ sub: 'x' }),
			() => ({ userinfo_endpoint: 'https://attacker.example/userinfo' }),
		);

		await expect(identifier.resolve('Bearer t', config)).rejects.toThrow(CredentialResolutionError);
		expect(callsTo('https://attacker.example/userinfo')).toHaveLength(0);
	});

	it('never follows redirects with the token attached', async () => {
		await identifier.resolve('Bearer t', config);

		expect(callsTo(USERINFO)[0][0]).toMatchObject({
			maxRedirects: 0,
			sendCredentialsOnCrossOriginRedirect: false,
		});
	});

	it('refuses when the provider cannot be reached', async () => {
		request.mockRejectedValue(new Error('ECONNREFUSED'));

		await expect(identifier.resolve('Bearer t', config)).rejects.toThrow(CredentialResolutionError);
	});
});
