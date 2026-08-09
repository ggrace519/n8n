import type { SamlPreferences } from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { ServiceProviderInstance } from 'samlify';
import type * as Samlify from 'samlify';

import { UrlService } from '@/services/url.service';

/** The SP entityID doubles as the public URL serving the SP metadata document. */
export function getServiceProviderEntityId(): string {
	const restEndpoint = Container.get(GlobalConfig).endpoints.rest;
	return `${Container.get(UrlService).getInstanceBaseUrl()}/${restEndpoint}/sso/saml/metadata`;
}

/** Assertion Consumer Service URL the IdP posts/redirects SAML responses to. */
export function getServiceProviderReturnUrl(): string {
	const restEndpoint = Container.get(GlobalConfig).endpoints.rest;
	return `${Container.get(UrlService).getInstanceBaseUrl()}/${restEndpoint}/sso/saml/acs`;
}

/**
 * Frontend route (deliberately not under the REST prefix) that shows
 * connection-test results. The ACS recognizes a connection-test callback by
 * its RelayState pointing at this URL.
 */
export function getServiceProviderConfigTestReturnUrl(): string {
	return `${Container.get(UrlService).getInstanceBaseUrl()}/config/test/return`;
}

/**
 * Build a samlify service provider reflecting the given preferences. The
 * private key must already be decrypted; RelayState is per-request and must
 * be passed to `createLoginRequest`, never configured on the entity.
 */
export function createServiceProviderInstance(
	prefs: SamlPreferences,
	samlify: typeof Samlify,
	decryptedSigningPrivateKey?: string,
): ServiceProviderInstance {
	return samlify.ServiceProvider({
		entityID: getServiceProviderEntityId(),
		assertionConsumerService: [
			{
				isDefault: true,
				Binding:
					prefs.acsBinding === 'redirect'
						? samlify.Constants.namespace.binding.redirect
						: samlify.Constants.namespace.binding.post,
				Location: getServiceProviderReturnUrl(),
			},
		],
		authnRequestsSigned: prefs.authnRequestsSigned,
		wantAssertionsSigned: prefs.wantAssertionsSigned,
		wantMessageSigned: prefs.wantMessageSigned,
		signatureConfig: prefs.signatureConfig,
		...(decryptedSigningPrivateKey ? { privateKey: decryptedSigningPrivateKey } : {}),
		...(prefs.signingCertificate ? { signingCert: prefs.signingCertificate } : {}),
	});
}
