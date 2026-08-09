import type { HttpRequestClient, OutboundHttp } from '@n8n/backend-network';
import { mockInstance } from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import { AuthIdentityRepository, UserRepository } from '@n8n/db';
import type { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type express from 'express';
import type { Cipher } from 'n8n-core';
import type * as Samlify from 'samlify';
import { createSign } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mock } from 'vitest-mock-extended';

import type { ProvisioningService } from '@/modules/provisioning/provisioning.service';

import { RSA_TEST_CERTIFICATE, RSA_TEST_PRIVATE_KEY } from './saml-signing-test-fixtures';
import { SAML_FLOW_COOKIE_NAME } from '../constants';
import { SamlFlowState } from '../saml-flow-state';
import { SamlService } from '../saml.service';
import { SamlValidator } from '../saml-validator';
import { getServiceProviderEntityId, getServiceProviderReturnUrl } from '../service-provider';

const CERTIFICATE_B64 = RSA_TEST_CERTIFICATE.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

const IDP_ENTITY_ID = 'https://idp.example.com/metadata';

const IDP_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor entityID="${IDP_ENTITY_ID}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
	<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
		<KeyDescriptor use="signing">
			<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
				<X509Data><X509Certificate>${CERTIFICATE_B64}</X509Certificate></X509Data>
			</KeyInfo>
		</KeyDescriptor>
		<NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
		<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
	</IDPSSODescriptor>
</EntityDescriptor>`;

const MAPPING = {
	email: 'email',
	firstName: 'firstName',
	lastName: 'lastName',
	userPrincipalName: 'upn',
};

const validator = new SamlValidator(mock());
mockInstance(UserRepository);
mockInstance(AuthIdentityRepository);

const settingsRepository = mock<SettingsRepository>();
const cipher = mock<Cipher>();
const outboundHttp = mock<OutboundHttp>();
const provisioningService = mock<ProvisioningService>();
const globalConfig = Container.get(GlobalConfig);

type ResponseOverrides = {
	audience?: string;
	recipient?: string;
	destination?: string;
	responseInResponseTo?: string;
	subjectInResponseTo?: string;
	conditionsNotBefore?: string;
	conditionsNotOnOrAfter?: string;
	subjectNotOnOrAfter?: string;
	confirmationMethod?: string;
	omitSubjectConfirmationData?: boolean;
	omitSubjectNotOnOrAfter?: boolean;
	omitConditionsNotOnOrAfter?: boolean;
	responseId?: string;
	assertionId?: string;
};

let samlify: typeof Samlify;
let counter = 0;

const nextId = () => `_id${(counter += 1)}${Date.now()}`;

function buildResponseXml(requestId: string, overrides: ResponseOverrides): string {
	const now = new Date();
	const inFiveMinutes = new Date(now.getTime() + 5 * 60_000).toISOString();
	const audience = overrides.audience ?? getServiceProviderEntityId();
	const recipient = overrides.recipient ?? getServiceProviderReturnUrl();
	const destination = overrides.destination ?? getServiceProviderReturnUrl();
	const assertionId = overrides.assertionId ?? nextId();
	const subjectExpiry = overrides.omitSubjectNotOnOrAfter
		? ''
		: ` NotOnOrAfter="${overrides.subjectNotOnOrAfter ?? inFiveMinutes}"`;
	const subjectConfirmationData = overrides.omitSubjectConfirmationData
		? ''
		: `<saml:SubjectConfirmationData${subjectExpiry} Recipient="${recipient}" InResponseTo="${overrides.subjectInResponseTo ?? requestId}"/>`;
	const conditionsExpiry = overrides.omitConditionsNotOnOrAfter
		? ''
		: ` NotOnOrAfter="${overrides.conditionsNotOnOrAfter ?? inFiveMinutes}"`;

	return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${overrides.responseId ?? nextId()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${destination}" InResponseTo="${overrides.responseInResponseTo ?? requestId}"><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID><saml:SubjectConfirmation Method="${overrides.confirmationMethod ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer'}">${subjectConfirmationData}</saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${overrides.conditionsNotBefore ?? now.toISOString()}"${conditionsExpiry}><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>user@example.com</saml:AttributeValue></saml:Attribute><saml:Attribute Name="firstName"><saml:AttributeValue>Test</saml:AttributeValue></saml:Attribute><saml:Attribute Name="lastName"><saml:AttributeValue>User</saml:AttributeValue></saml:Attribute><saml:Attribute Name="upn"><saml:AttributeValue>user@example.com</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

/**
 * Produce a base64 login response signed by the configured identity provider.
 * `signAssertion` / `signMessage` select which signatures the identity
 * provider adds.
 */
async function buildSignedResponse(
	requestId: string,
	overrides: ResponseOverrides = {},
	{ signAssertion = true, signMessage = true } = {},
): Promise<string> {
	const idp = samlify.IdentityProvider({
		entityID: IDP_ENTITY_ID,
		privateKey: RSA_TEST_PRIVATE_KEY,
		signingCert: RSA_TEST_CERTIFICATE,
		singleSignOnService: [
			{
				Binding: samlify.Constants.namespace.binding.redirect,
				Location: 'https://idp.example.com/sso',
			},
		],
	});
	const sp = samlify.ServiceProvider({
		entityID: getServiceProviderEntityId(),
		assertionConsumerService: [
			{
				isDefault: true,
				Binding: samlify.Constants.namespace.binding.post,
				Location: getServiceProviderReturnUrl(),
			},
		],
		wantAssertionsSigned: signAssertion,
		wantMessageSigned: signMessage,
		signatureConfig: {
			prefix: 'ds',
			location: {
				reference: "/*[local-name(.)='Response']/*[local-name(.)='Issuer']",
				action: 'after',
			},
		},
	});

	const xml = buildResponseXml(requestId, overrides);
	const context = await idp.createLoginResponse(sp, null, 'post', {}, () => ({
		id: 'ignored',
		context: xml,
	}));
	return context.context;
}

/**
 * Same response, delivered over the redirect binding: deflated and carrying
 * the detached signature over `SAMLResponse=…&SigAlg=…` (SAML bindings §3.4.4.1).
 */
async function buildSignedRedirectResponse(
	requestId: string,
	overrides: ResponseOverrides = {},
	{ signAssertion = true } = {},
): Promise<string> {
	const signedXml = Buffer.from(
		await buildSignedResponse(requestId, overrides, { signAssertion, signMessage: false }),
		'base64',
	).toString();

	const samlResponse = encodeURIComponent(
		deflateRawSync(Buffer.from(signedXml)).toString('base64'),
	);
	const sigAlgValue = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
	const octetString = `SAMLResponse=${samlResponse}&SigAlg=${encodeURIComponent(sigAlgValue)}`;
	const signature = createSign('RSA-SHA256')
		.update(octetString)
		.sign(RSA_TEST_PRIVATE_KEY, 'base64');

	return `${getServiceProviderReturnUrl()}?${octetString}&Signature=${encodeURIComponent(signature)}`;
}

const redirectAcsRequest = (redirectUrl: string) => {
	const search = new URL(redirectUrl).search.slice(1);
	const query: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(search)) query[key] = value;
	return {
		body: {},
		query,
		cookies: {},
		url: `/rest/sso/saml/acs?${search}`,
	} as unknown as express.Request;
};

const acsRequest = (samlResponse: string, cookies: Record<string, string> = {}) =>
	({
		body: { SAMLResponse: samlResponse },
		query: {},
		cookies,
		url: '/rest/sso/saml/acs',
	}) as unknown as express.Request;

describe('SAML login response binding', () => {
	let service: SamlService;
	let flowState: SamlFlowState;

	beforeEach(async () => {
		vi.clearAllMocks();
		flowState = new SamlFlowState();
		settingsRepository.findByKey.mockResolvedValue(null);
		outboundHttp.requests.mockReturnValue(mock<HttpRequestClient>());
		provisioningService.getProvisioningConfig.mockResolvedValue({
			scopesProvisionInstanceRole: false,
			scopesProvisionProjectRoles: false,
			scopesUseExpressionMapping: false,
			scopesName: 'n8n',
			scopesInstanceRoleClaimName: 'n8n_instance_role',
			scopesProjectsRolesClaimName: 'n8n_projects',
		});

		service = new SamlService(
			mock(),
			globalConfig,
			validator,
			settingsRepository,
			mockInstance(UserRepository),
			cipher,
			outboundHttp,
			provisioningService,
			flowState,
		);

		await service.setSamlPreferences({
			metadata: IDP_METADATA,
			mapping: MAPPING,
			loginBinding: 'redirect',
			acsBinding: 'post',
			wantAssertionsSigned: true,
			wantMessageSigned: false,
		});
		samlify = await import('samlify');
	});

	const registerRequest = (flowId?: string) => {
		const requestId = nextId();
		flowState.registerAuthnRequest(requestId, flowId);
		return requestId;
	};

	describe('accepted responses', () => {
		test('accepts a response that answers a request issued by this instance', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId);

			const result = await service.getAttributesFromLoginResponse(acsRequest(response), 'post');

			expect(result.mapped.email).toBe('user@example.com');
			expect(result.mapped.userPrincipalName).toBe('user@example.com');
		});

		test('accepts a response when the browser sends no flow cookie', async () => {
			const requestId = registerRequest('flow-1');
			const response = await buildSignedResponse(requestId);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).resolves.toBeDefined();
		});

		test('accepts a response whose flow cookie matches the issued request', async () => {
			const requestId = registerRequest('flow-1');
			const response = await buildSignedResponse(requestId);

			await expect(
				service.getAttributesFromLoginResponse(
					acsRequest(response, { [SAML_FLOW_COOKIE_NAME]: 'flow-1' }),
					'post',
				),
			).resolves.toBeDefined();
		});
	});

	describe('service provider addressing', () => {
		test('rejects an assertion issued for a different audience', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				audience: 'https://other.example.com/rest/sso/saml/metadata',
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('addressed to a different audience');
		});

		test('rejects an assertion confirmed for a different recipient', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				recipient: 'https://other.example.com/rest/sso/saml/acs',
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('addressed to a different recipient');
		});

		test('rejects a response sent to a different destination', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				destination: 'https://other.example.com/rest/sso/saml/acs',
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('addressed to a different destination');
		});
	});

	describe('subject confirmation', () => {
		test('rejects an assertion without subject confirmation data', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, { omitSubjectConfirmationData: true });

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('missing bearer subject confirmation data');
		});

		test('rejects an assertion confirmed by a non-bearer method', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				confirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('bearer subject confirmation');
		});
	});

	describe('validity windows', () => {
		test('rejects an assertion whose conditions window has passed', async () => {
			const requestId = registerRequest();
			const past = new Date(Date.now() - 10 * 60_000).toISOString();
			const response = await buildSignedResponse(requestId, {
				conditionsNotBefore: new Date(Date.now() - 20 * 60_000).toISOString(),
				conditionsNotOnOrAfter: past,
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow();
		});

		test('rejects an assertion that is not valid yet', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				conditionsNotBefore: new Date(Date.now() + 10 * 60_000).toISOString(),
				conditionsNotOnOrAfter: new Date(Date.now() + 20 * 60_000).toISOString(),
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow();
		});

		test('rejects an assertion that declares no conditions expiry', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, { omitConditionsNotOnOrAfter: true });

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('does not declare a validity window');
		});

		test('rejects an assertion whose subject confirmation declares no expiry', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, { omitSubjectNotOnOrAfter: true });

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('missing bearer subject confirmation data');
		});

		test('rejects an assertion whose subject confirmation window has passed', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				subjectNotOnOrAfter: new Date(Date.now() - 10 * 60_000).toISOString(),
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('subject confirmation validity window has passed');
		});
	});

	describe('login request binding', () => {
		test('rejects a response that answers no pending request', async () => {
			registerRequest();
			const response = await buildSignedResponse('_never-issued');

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('does not answer a pending login request');
		});

		test('rejects a response whose message and assertion name different requests', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId, {
				subjectInResponseTo: '_another-request',
			});

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('refer to different login requests');
		});

		test('rejects a response whose flow cookie belongs to another login flow', async () => {
			const requestId = registerRequest('flow-1');
			const response = await buildSignedResponse(requestId);

			await expect(
				service.getAttributesFromLoginResponse(
					acsRequest(response, { [SAML_FLOW_COOKIE_NAME]: 'flow-2' }),
					'post',
				),
			).rejects.toThrow('belongs to a different login flow');
		});

		test('rejects a second use of the same response', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).resolves.toBeDefined();

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow(/already been used|does not answer a pending login request/);
		});

		test('rejects a replayed response even when a fresh request is pending', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(requestId);
			await service.getAttributesFromLoginResponse(acsRequest(response), 'post');

			// the same message IDs are now recorded, so the retry cannot be re-used
			flowState.registerAuthnRequest(requestId);
			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('already been used');
		});
	});

	describe('signature requirements', () => {
		test('rejects an unsigned assertion when assertion signing is required', async () => {
			const requestId = registerRequest();
			const response = await buildSignedResponse(
				requestId,
				{},
				{ signAssertion: false, signMessage: true },
			);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).rejects.toThrow('assertion is not signed by the configured identity provider');
		});

		test('accepts a message-level signature when assertion signing is not required', async () => {
			await service.setSamlPreferences({ wantAssertionsSigned: false, wantMessageSigned: true });
			const requestId = registerRequest();
			const response = await buildSignedResponse(
				requestId,
				{},
				{ signAssertion: false, signMessage: true },
			);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).resolves.toBeDefined();
		});

		test('accepts an assertion-only signature under the default requirements', async () => {
			// the shipped defaults request both signatures, but the service-provider
			// metadata only advertises the assertion requirement
			await service.setSamlPreferences({ wantAssertionsSigned: true, wantMessageSigned: true });
			const requestId = registerRequest();
			const response = await buildSignedResponse(
				requestId,
				{},
				{ signAssertion: true, signMessage: false },
			);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).resolves.toBeDefined();
		});

		test('accepts a response carrying both signatures when both are required', async () => {
			await service.setSamlPreferences({ wantAssertionsSigned: true, wantMessageSigned: true });
			const requestId = registerRequest();
			const response = await buildSignedResponse(
				requestId,
				{},
				{ signAssertion: true, signMessage: true },
			);

			await expect(
				service.getAttributesFromLoginResponse(acsRequest(response), 'post'),
			).resolves.toBeDefined();
		});
	});

	describe('redirect binding', () => {
		beforeEach(async () => {
			await service.setSamlPreferences({ acsBinding: 'redirect' });
		});

		test('accepts a redirect-binding response with a signed assertion', async () => {
			const requestId = registerRequest();
			const redirectUrl = await buildSignedRedirectResponse(requestId);

			await expect(
				service.getAttributesFromLoginResponse(redirectAcsRequest(redirectUrl), 'redirect'),
			).resolves.toBeDefined();
		});

		test('rejects a redirect-binding response whose assertion is unsigned', async () => {
			const requestId = registerRequest();
			const redirectUrl = await buildSignedRedirectResponse(
				requestId,
				{},
				{ signAssertion: false },
			);

			await expect(
				service.getAttributesFromLoginResponse(redirectAcsRequest(redirectUrl), 'redirect'),
			).rejects.toThrow('assertion is not signed by the configured identity provider');
		});

		test('rejects a redirect-binding response addressed to another audience', async () => {
			const requestId = registerRequest();
			const redirectUrl = await buildSignedRedirectResponse(requestId, {
				audience: 'https://other.example.com/rest/sso/saml/metadata',
			});

			await expect(
				service.getAttributesFromLoginResponse(redirectAcsRequest(redirectUrl), 'redirect'),
			).rejects.toThrow('addressed to a different audience');
		});
	});

	describe('login request issuance', () => {
		test('retains the issued request id and binds it to a browser flow cookie', async () => {
			const res = mock<express.Response>();
			const loginUrl = await service.getLoginRequest('', res);

			expect(res.cookie).toHaveBeenCalledWith(
				SAML_FLOW_COOKIE_NAME,
				expect.any(String),
				expect.objectContaining({ httpOnly: true }),
			);
			const [, flowId] = res.cookie.mock.calls[0] as [string, string, unknown];

			const samlRequest = new URL(loginUrl).searchParams.get('SAMLRequest');
			const requestXml = inflateRawSync(Buffer.from(samlRequest!, 'base64')).toString();
			const requestId = /ID="([^"]+)"/.exec(requestXml)![1];

			const response = await buildSignedResponse(requestId);
			await expect(
				service.getAttributesFromLoginResponse(
					acsRequest(response, { [SAML_FLOW_COOKIE_NAME]: flowId }),
					'post',
				),
			).resolves.toBeDefined();
		});
	});
});
