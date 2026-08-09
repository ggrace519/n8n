import type { AuthenticationMethod } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { UserError } from 'n8n-workflow';

import config from '@/config';

const AUTH_METHOD_SETTING_KEY = 'userManagement.authenticationMethod';

/**
 * The instance-wide login method. State lives in the runtime config (for
 * synchronous reads on hot paths) and is persisted as a load-on-startup
 * settings row, which `start` feeds back into the config on boot.
 */
export function getCurrentAuthenticationMethod(): AuthenticationMethod {
	return config.getEnv(AUTH_METHOD_SETTING_KEY) as AuthenticationMethod;
}

export async function setCurrentAuthenticationMethod(
	authenticationMethod: AuthenticationMethod,
): Promise<void> {
	config.set(AUTH_METHOD_SETTING_KEY, authenticationMethod);
	await Container.get(SettingsRepository).upsertByKey(
		AUTH_METHOD_SETTING_KEY,
		authenticationMethod,
		true,
		{},
	);
}

export function isEmailCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'email';
}

export function isLdapCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'ldap';
}

export function isSamlCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'saml';
}

export function isOidcCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'oidc';
}

/** Whether a single-sign-on protocol (SAML or OIDC) is the active login method. */
export function isSsoCurrentAuthenticationMethod(): boolean {
	return isSamlCurrentAuthenticationMethod() || isOidcCurrentAuthenticationMethod();
}

/**
 * Guard for enabling an SSO protocol: only one of SAML/OIDC/LDAP may be
 * active, so a protocol can only be enabled from `email` or from itself —
 * never by silently displacing another protocol.
 */
export function assertAuthenticationMethodCanBeEnabled(
	authenticationMethod: Extract<AuthenticationMethod, 'saml' | 'oidc' | 'ldap'>,
): void {
	const current = getCurrentAuthenticationMethod();
	if (current !== 'email' && current !== authenticationMethod) {
		throw new UserError(
			`Cannot enable ${authenticationMethod} login while ${current} login is active. Disable ${current} first.`,
		);
	}
}

export function isSamlLicensed(): boolean {
	return Container.get(LicenseState).isSamlLicensed();
}

export function isOidcLicensed(): boolean {
	return Container.get(LicenseState).isOidcLicensed();
}

export function isSamlLoginEnabled(): boolean {
	return Container.get(GlobalConfig).sso.saml.loginEnabled;
}

export function isSamlLicensedAndEnabled(): boolean {
	return isSamlLoginEnabled() && isSamlLicensed() && isSamlCurrentAuthenticationMethod();
}

export function getSamlLoginLabel(): string {
	return Container.get(GlobalConfig).sso.saml.loginLabel;
}
