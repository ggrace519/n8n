import type { HttpRequestClient, OutboundHttp } from '@n8n/backend-network';
import { mockInstance } from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import { AuthIdentityRepository, User, UserRepository } from '@n8n/db';
import type { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type express from 'express';
import type { Cipher } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import type { ProvisioningService } from '@/modules/provisioning/provisioning.service';

import { RSA_TEST_CERTIFICATE, RSA_TEST_PRIVATE_KEY } from './saml-signing-test-fixtures';
import { SamlFlowState } from '../saml-flow-state';
import { SamlValidator } from '../saml-validator';
import { SamlService } from '../saml.service';

const CERTIFICATE_B64 = RSA_TEST_CERTIFICATE.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

const buildMetadata = (ssoBinding: string) => `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor entityID="https://idp.example.com/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
	<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
		<KeyDescriptor use="signing">
			<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
				<X509Data><X509Certificate>${CERTIFICATE_B64}</X509Certificate></X509Data>
			</KeyInfo>
		</KeyDescriptor>
		<NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
		<SingleSignOnService Binding="${ssoBinding}" Location="https://idp.example.com/sso"/>
	</IDPSSODescriptor>
</EntityDescriptor>`;

const VALID_METADATA = buildMetadata('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
const POST_ONLY_METADATA = buildMetadata('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');

const validator = new SamlValidator(mock());
const userRepository = mockInstance(UserRepository);
mockInstance(AuthIdentityRepository);

const settingsRepository = mock<SettingsRepository>();
const cipher = mock<Cipher>();
const outboundHttp = mock<OutboundHttp>();
const httpClient = mock<HttpRequestClient>();
const provisioningService = mock<ProvisioningService>();

const globalConfig = Container.get(GlobalConfig);

describe('SamlService', () => {
	let service: SamlService;
	let flowState: SamlFlowState;

	beforeEach(() => {
		vi.clearAllMocks();
		flowState = new SamlFlowState();
		settingsRepository.findByKey.mockResolvedValue(null);
		cipher.encrypt.mockImplementation((data) => `encrypted:${String(data)}`);
		cipher.decrypt.mockImplementation((data) => data.replace(/^encrypted:/, ''));
		outboundHttp.requests.mockReturnValue(httpClient);
		provisioningService.getProvisioningConfig.mockResolvedValue({
			scopesProvisionInstanceRole: false,
			scopesProvisionProjectRoles: false,
			scopesUseExpressionMapping: false,
			scopesName: 'n8n',
			scopesInstanceRoleClaimName: 'n8n_instance_role',
			scopesProjectsRolesClaimName: 'n8n_projects',
		});
		provisioningService.resolveLoginProvisioning.mockResolvedValue({
			outcome: 'allow',
			provider: 'saml',
			projectRoles: [],
			managedProjectIds: [],
		});
		provisioningService.applyLoginProvisioning.mockResolvedValue({
			instanceRoleChanged: false,
			projectsAdded: 0,
			projectsRemoved: 0,
		});

		service = new SamlService(
			mock(),
			globalConfig,
			validator,
			settingsRepository,
			userRepository,
			cipher,
			outboundHttp,
			provisioningService,
			flowState,
		);
	});

	afterEach(() => {
		delete process.env.N8N_ENV_FEAT_SIGNED_SAML_REQUESTS;
		globalConfig.sso.justInTimeProvisioning = true;
	});

	describe('setSamlPreferences metadata validation', () => {
		it('rejects metadata that is not valid SAML metadata XML', async () => {
			await expect(
				service.setSamlPreferences({ metadata: 'this is not SAML metadata' }),
			).rejects.toThrowError(BadRequestError);
			expect(settingsRepository.save).not.toHaveBeenCalled();
		});

		it('rejects metadata whose IdP offers no redirect binding', async () => {
			await expect(
				service.setSamlPreferences({ metadata: POST_ONLY_METADATA }),
			).rejects.toThrowError('only SAML redirect binding is supported');
			expect(settingsRepository.save).not.toHaveBeenCalled();
		});

		it('accepts valid metadata and persists it', async () => {
			await service.setSamlPreferences({ metadata: VALID_METADATA });

			expect(service.samlPreferences.metadata).toBe(VALID_METADATA);
			expect(settingsRepository.save).toHaveBeenCalledWith(
				expect.objectContaining({ key: 'features.saml', loadOnStartup: true }),
			);
		});
	});

	describe('fetchMetadataFromUrl', () => {
		const metadataUrl = 'https://idp.example.com/metadata';

		it('returns the fetched XML when it is valid metadata', async () => {
			httpClient.request.mockResolvedValue(VALID_METADATA);

			await expect(service.fetchMetadataFromUrl(metadataUrl)).resolves.toBe(VALID_METADATA);
			expect(httpClient.request).toHaveBeenCalledWith(
				expect.objectContaining({ url: metadataUrl, method: 'GET' }),
			);
		});

		it('rejects with the pinned error when the endpoint serves non-metadata', async () => {
			httpClient.request.mockResolvedValue('junk response');

			const promise = service.fetchMetadataFromUrl(metadataUrl);
			await expect(promise).rejects.toThrowError(BadRequestError);
			await expect(promise).rejects.toThrowError(
				`Failed to produce valid SAML metadata from ${metadataUrl}`,
			);
		});

		it('rejects with the pinned error when the request itself fails', async () => {
			httpClient.request.mockRejectedValue(new Error('connection refused'));

			await expect(service.fetchMetadataFromUrl(metadataUrl)).rejects.toThrowError(
				`Failed to produce valid SAML metadata from ${metadataUrl}`,
			);
		});
	});

	describe('connection-test token flow', () => {
		it('embeds a single-use hex token pointing at the test return URL', async () => {
			const loginUrl = await service.createConnectionTestRequest({
				metadata: VALID_METADATA,
				loginBinding: 'redirect',
			});

			const relayState = new URL(loginUrl).searchParams.get('RelayState');
			expect(relayState).toBeTruthy();
			const relayStateUrl = new URL(relayState!);
			expect(relayStateUrl.pathname).toBe('/config/test/return');
			const testId = relayStateUrl.searchParams.get('t');
			expect(testId).toMatch(/^[0-9a-f]+$/);

			// first consumption returns the retained (unsaved) preferences
			const consumed = await service.consumePendingTestConfig(testId!);
			expect(consumed?.metadata).toBe(VALID_METADATA);
			// the active configuration was not touched
			expect(service.samlPreferences.metadata).toBeUndefined();
			// the token is single-use
			await expect(service.consumePendingTestConfig(testId!)).resolves.toBeUndefined();
		});

		it('does not hand out expired test configs', async () => {
			const loginUrl = await service.createConnectionTestRequest({
				metadata: VALID_METADATA,
				loginBinding: 'redirect',
			});
			const relayState = new URL(loginUrl).searchParams.get('RelayState')!;
			const testId = new URL(relayState).searchParams.get('t')!;

			const later = Date.now() + 6 * 60_000;
			const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(later);
			try {
				await expect(service.consumePendingTestConfig(testId)).resolves.toBeUndefined();
			} finally {
				nowSpy.mockRestore();
			}
		});

		it('rejects a connection test without any metadata', async () => {
			await expect(service.createConnectionTestRequest({})).rejects.toThrowError(BadRequestError);
		});
	});

	describe('signing key storage', () => {
		it('rejects new signing material when the feature flag is off', async () => {
			delete process.env.N8N_ENV_FEAT_SIGNED_SAML_REQUESTS;

			await expect(
				service.setSamlPreferences({
					signingPrivateKey: RSA_TEST_PRIVATE_KEY,
					signingCertificate: RSA_TEST_CERTIFICATE,
				}),
			).rejects.toThrowError('SAML request signing is not enabled');
		});

		it('encrypts the private key at rest and decrypts it round-trip', async () => {
			process.env.N8N_ENV_FEAT_SIGNED_SAML_REQUESTS = 'true';

			await service.setSamlPreferences({
				signingPrivateKey: RSA_TEST_PRIVATE_KEY,
				signingCertificate: RSA_TEST_CERTIFICATE,
			});

			expect(service.samlPreferences.signingPrivateKey).toBe(`encrypted:${RSA_TEST_PRIVATE_KEY}`);
			expect(service.samlPreferences.signingCertificate).toBe(RSA_TEST_CERTIFICATE);

			type WithPrivateKey = { getDecryptedSigningPrivateKey: () => Promise<string | undefined> };
			const decrypted = await (
				service as unknown as WithPrivateKey
			).getDecryptedSigningPrivateKey();
			expect(decrypted).toBe(RSA_TEST_PRIVATE_KEY);
		});

		it('rejects a key/certificate pair that does not match', async () => {
			process.env.N8N_ENV_FEAT_SIGNED_SAML_REQUESTS = 'true';

			// self-signed cert generated for an unrelated key
			const { generateKeyPairSync } = await import('node:crypto');
			const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

			await expect(
				service.setSamlPreferences({
					signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
					signingCertificate: RSA_TEST_CERTIFICATE,
				}),
			).rejects.toThrowError('do not match');
		});
	});

	describe('handleSamlLogin', () => {
		const mockRequest = mock<express.Request>();

		it('throws BadRequestError for an invalid mapped email', async () => {
			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email: 'not-an-email',
					firstName: 'First',
					lastName: 'Last',
					userPrincipalName: 'upn',
				},
				raw: {},
			});

			const promise = service.handleSamlLogin(mockRequest, 'post');
			await expect(promise).rejects.toThrowError(BadRequestError);
			await expect(promise).rejects.toThrowError('Invalid email format');
		});

		it('rejects unknown users when just-in-time provisioning is disabled', async () => {
			globalConfig.sso.justInTimeProvisioning = false;
			userRepository.findOne.mockResolvedValue(null);
			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email: 'new.user@example.com',
					firstName: 'New',
					lastName: 'User',
					userPrincipalName: 'new.user',
				},
				raw: {},
			});

			await expect(service.handleSamlLogin(mockRequest, 'post')).rejects.toThrowError(AuthError);
		});

		it('updates an existing user and preserves the IdP email casing in the result', async () => {
			const user = Object.assign(new User(), {
				id: 'user-id',
				email: 'existing@example.com',
				firstName: 'Old',
				lastName: 'Name',
				authIdentities: [],
			});
			userRepository.findOne.mockResolvedValue(user);
			userRepository.save.mockResolvedValue(user);

			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email: 'EXISTING@EXAMPLE.COM',
					firstName: 'New',
					lastName: 'Name',
					userPrincipalName: 'existing',
				},
				raw: {},
			});

			const result = await service.handleSamlLogin(mockRequest, 'post');

			// lookup by lowercased email, but the returned attributes keep the IdP casing
			expect(userRepository.findOne).toHaveBeenCalledWith(
				expect.objectContaining({ where: { email: 'existing@example.com' } }),
			);
			expect(result.attributes.email).toBe('EXISTING@EXAMPLE.COM');
			expect(result.authenticatedUser).toBeDefined();
		});
	});

	describe('linking a login to an existing account', () => {
		const mockRequest = mock<express.Request>();

		const mockAssertedUser = (email: string) => {
			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email,
					firstName: 'New',
					lastName: 'Name',
					userPrincipalName: email,
				},
				raw: { email },
			});
		};

		const existingUser = (roleSlug: string, authIdentities: Array<{ providerType: string }>) =>
			Object.assign(new User(), {
				id: 'user-id',
				email: 'privileged@example.com',
				firstName: 'Old',
				lastName: 'Name',
				role: { slug: roleSlug },
				authIdentities,
			});

		it.each([['global:owner'], ['global:admin']])(
			'refuses to link a login to an unlinked <%s> account and writes nothing',
			async (roleSlug) => {
				userRepository.findOne.mockResolvedValue(existingUser(roleSlug, []));
				mockAssertedUser('privileged@example.com');

				const promise = service.handleSamlLogin(mockRequest, 'post');
				await expect(promise).rejects.toThrowError(AuthError);
				await expect(promise).rejects.toThrowError('SAML login failed');
				expect(userRepository.save).not.toHaveBeenCalled();
			},
		);

		it.each([['global:owner'], ['global:admin']])(
			'signs in a <%s> account that already has a linked SAML identity',
			async (roleSlug) => {
				const user = existingUser(roleSlug, [{ providerType: 'saml' }]);
				userRepository.findOne.mockResolvedValue(user);
				userRepository.save.mockResolvedValue(user);
				mockAssertedUser('privileged@example.com');

				await expect(service.handleSamlLogin(mockRequest, 'post')).resolves.toBeDefined();
			},
		);

		it('signs in an existing member account matched by email', async () => {
			const user = existingUser('global:member', []);
			userRepository.findOne.mockResolvedValue(user);
			userRepository.save.mockResolvedValue(user);
			mockAssertedUser('privileged@example.com');

			await expect(service.handleSamlLogin(mockRequest, 'post')).resolves.toBeDefined();
		});
	});

	describe('role provisioning policy', () => {
		const mockRequest = mock<express.Request>();

		beforeEach(() => {
			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email: 'provisioned@example.com',
					firstName: 'New',
					lastName: 'User',
					userPrincipalName: 'provisioned',
				},
				raw: { email: 'provisioned@example.com' },
			});
			userRepository.findOne.mockResolvedValue(null);
		});

		it.each([
			['access is blocked by the policy', 'block-access' as const],
			['the policy cannot be evaluated', 'evaluation-failed' as const],
		])('denies the login before any account is looked up when %s', async (_, reason) => {
			provisioningService.resolveLoginProvisioning.mockResolvedValue({ outcome: 'deny', reason });

			await expect(service.handleSamlLogin(mockRequest, 'post')).rejects.toThrowError(
				ForbiddenError,
			);
			expect(userRepository.findOne).not.toHaveBeenCalled();
			expect(userRepository.createUserWithProject).not.toHaveBeenCalled();
			expect(userRepository.save).not.toHaveBeenCalled();
		});

		it('evaluates the policy against the raw assertion and the mapped role claims', async () => {
			vi.spyOn(service, 'getAttributesFromLoginResponse').mockResolvedValue({
				mapped: {
					email: 'provisioned@example.com',
					firstName: 'New',
					lastName: 'User',
					userPrincipalName: 'provisioned',
					n8nInstanceRole: 'global:admin',
					n8nProjectRoles: ['project-1:project:editor'],
				},
				raw: { email: 'provisioned@example.com', department: 'it' },
			});
			userRepository.findOne.mockResolvedValue(
				Object.assign(new User(), {
					id: 'user-id',
					email: 'provisioned@example.com',
					role: { slug: 'global:member' },
					authIdentities: [{ providerType: 'saml' }],
				}),
			);
			userRepository.save.mockResolvedValue(new User());

			await service.handleSamlLogin(mockRequest, 'post');

			expect(provisioningService.resolveLoginProvisioning).toHaveBeenCalledWith({
				provider: 'saml',
				claims: { email: 'provisioned@example.com', department: 'it' },
				providerContext: {
					provider: 'saml',
					rawAttributes: { email: 'provisioned@example.com', department: 'it' },
				},
				directClaims: {
					instanceRole: 'global:admin',
					projectRoles: ['project-1:project:editor'],
				},
			});
		});

		it('applies the decision to the account the login resolved to', async () => {
			const user = Object.assign(new User(), {
				id: 'user-id',
				email: 'provisioned@example.com',
				role: { slug: 'global:member' },
				authIdentities: [{ providerType: 'saml' }],
			});
			userRepository.findOne.mockResolvedValue(user);
			userRepository.save.mockResolvedValue(user);

			await service.handleSamlLogin(mockRequest, 'post');

			expect(provisioningService.applyLoginProvisioning).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'user-id' }),
				expect.objectContaining({ outcome: 'allow' }),
			);
		});

		it('allows the login when no provisioning policy is configured', async () => {
			userRepository.findOne.mockResolvedValue(
				Object.assign(new User(), {
					id: 'user-id',
					email: 'provisioned@example.com',
					role: { slug: 'global:member' },
					authIdentities: [{ providerType: 'saml' }],
				}),
			);
			userRepository.save.mockResolvedValue(new User());

			await expect(service.handleSamlLogin(mockRequest, 'post')).resolves.toBeDefined();
		});
	});

	describe('getAttributesFromLoginResponse', () => {
		it('throws AuthError when required attributes are missing', async () => {
			await service.setSamlPreferences({ metadata: VALID_METADATA });

			type WithExtract = {
				extractAttributes: () => Promise<{
					attributes: unknown;
					missingAttributes: string[];
					rawAttributes: Record<string, unknown>;
				}>;
			};
			vi.spyOn(service as unknown as WithExtract, 'extractAttributes').mockResolvedValue({
				attributes: { email: 'a@b.co' },
				missingAttributes: ['userPrincipalName', 'firstName', 'lastName'],
				rawAttributes: { email: 'a@b.co' },
			});

			await expect(
				service.getAttributesFromLoginResponse(mock<express.Request>(), 'post'),
			).rejects.toThrowError(AuthError);
		});
	});
});
