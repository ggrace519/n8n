import type { SamlPreferences } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { SettingsRepository, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type express from 'express';
import { Cipher } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE, jsonParse, UnexpectedError } from 'n8n-workflow';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import type { IdentityProviderInstance, ServiceProviderInstance } from 'samlify';
import type * as Samlify from 'samlify';
import type { ESamlHttpRequest } from 'samlify/types/src/entity';

import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import { isSamlLoginEnabled } from '@/sso/sso-helpers';

import { SAML_PREFERENCES_DB_KEY } from './constants';
import {
	createUserFromSamlAttributes,
	getMappedSamlAttributesFromFlowResult,
	setSamlLoginEnabled,
	setSamlLoginLabel,
	updateUserFromSamlAttributes,
} from './saml-helpers';
import { SamlValidator } from './saml-validator';
import {
	createServiceProviderInstance,
	getServiceProviderConfigTestReturnUrl,
} from './service-provider';
import type { SamlLoginBinding, SamlUserAttributes } from './types';
import { getInitSSOFormView } from './views/init-sso-post';

type SamlifyModule = typeof Samlify;

type MappedAttributesResult = ReturnType<typeof getMappedSamlAttributesFromFlowResult>;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const METADATA_FETCH_TIMEOUT_MS = 10_000;

/** Unconsumed connection-test configs are dropped after this window. */
const PENDING_TEST_CONFIG_TTL_MS = 5 * 60_000;

const defaultSamlPreferences = (): SamlPreferences => ({
	ignoreSSL: false,
	loginBinding: 'redirect',
	loginEnabled: false,
	loginLabel: '',
	acsBinding: 'post',
	authnRequestsSigned: false,
	wantAssertionsSigned: true,
	wantMessageSigned: true,
	signatureConfig: {
		prefix: 'ds',
		location: {
			reference: '/samlp:Response/saml:Issuer',
			action: 'after',
		},
	},
	relayState: '',
});

/** Reject signing material that node's crypto layer cannot parse as PEM. */
function assertPemFormats(newPrivateKey?: string, newCertificate?: string): void {
	if (newPrivateKey !== undefined) {
		try {
			createPrivateKey(newPrivateKey);
		} catch {
			throw new BadRequestError('Invalid signing private key format');
		}
	}
	if (newCertificate !== undefined) {
		try {
			new X509Certificate(newCertificate);
		} catch {
			throw new BadRequestError('Invalid signing certificate format');
		}
	}
}

/**
 * Interpret a secret-field update: `''` clears the stored value, the blanking
 * placeholder (or an absent field) keeps it, anything else is new material.
 */
function parseSecretUpdate(value: string | undefined): { newValue?: string; clear: boolean } {
	if (value === undefined || value === CREDENTIAL_BLANKING_VALUE) return { clear: false };
	if (value === '') return { clear: true };
	return { newValue: value, clear: false };
}

/** Narrow an express request to the minimal shape samlify consumes. */
function toEsamlHttpRequest(req: express.Request): ESamlHttpRequest {
	const query: Record<string, string | undefined> = {};
	const rawQuery: unknown = req.query;
	if (typeof rawQuery === 'object' && rawQuery !== null) {
		for (const [key, value] of Object.entries(rawQuery)) {
			if (typeof value === 'string') query[key] = value;
		}
	}
	const body: Record<string, string | undefined> = {};
	const rawBody: unknown = req.body;
	if (typeof rawBody === 'object' && rawBody !== null) {
		for (const [key, value] of Object.entries(rawBody)) {
			if (typeof value === 'string') body[key] = value;
		}
	}
	// samlify's redirect binding verifies the signature over the raw query string
	const octetString = typeof req.url === 'string' ? (req.url.split('?')[1] ?? '') : '';
	return { query, body, octetString };
}

/**
 * SAML 2.0 single sign-on: preference lifecycle (persisted as a
 * load-on-startup settings row under `features.saml`, signing private key
 * encrypted at rest), IdP metadata validation/fetching, service-provider
 * metadata, login request creation, assertion consumption with attribute
 * mapping, and the unsaved connection-test flow.
 */
@Service()
export class SamlService {
	private _samlPreferences: SamlPreferences = defaultSamlPreferences();

	private samlify: SamlifyModule | undefined;

	private identityProviderInstance: IdentityProviderInstance | undefined;

	private initialized = false;

	private readonly pendingTestConfigs = new Map<
		string,
		{ preferences: SamlPreferences; expiresAt: number }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly validator: SamlValidator,
		private readonly settingsRepository: SettingsRepository,
		private readonly userRepository: UserRepository,
		private readonly cipher: Cipher,
		private readonly outboundHttp: OutboundHttp,
		private readonly provisioningService: ProvisioningService,
	) {}

	get samlPreferences(): SamlPreferences {
		return { ...this._samlPreferences };
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await this.ensureLibs();
		await this.loadFromDbAndApplySamlPreferences(true);
		this.initialized = true;
	}

	/** Lazy-load samlify and the schema validator; wire response validation. */
	private async ensureLibs(): Promise<SamlifyModule> {
		if (!this.samlify) {
			this.samlify = await import('samlify');
			await this.validator.init();
			this.samlify.setSchemaValidator({
				validate: async (response: string) => {
					const valid = await this.validator.validateResponse(response);
					if (!valid) {
						throw new UnexpectedError(
							'SAML response does not conform to the SAML 2.0 protocol schema',
						);
					}
					return 'valid';
				},
			});
		} else {
			await this.validator.init();
		}
		return this.samlify;
	}

	async loadFromDbAndApplySamlPreferences(
		applyLoginState: boolean,
	): Promise<SamlPreferences | undefined> {
		const row = await this.settingsRepository.findByKey(SAML_PREFERENCES_DB_KEY);
		if (!row?.value) return undefined;

		const stored = jsonParse<Partial<SamlPreferences>>(row.value, { fallbackValue: {} });
		this._samlPreferences = { ...defaultSamlPreferences(), ...stored };
		this.identityProviderInstance = undefined;

		if (applyLoginState) {
			if (typeof stored.loginEnabled === 'boolean') {
				try {
					await setSamlLoginEnabled(stored.loginEnabled);
				} catch (error) {
					this.logger.warn(
						`Stored SAML login state could not be applied: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			if (typeof stored.loginLabel === 'string') setSamlLoginLabel(stored.loginLabel);
		}

		return this.samlPreferences;
	}

	async setSamlPreferences(prefs: Partial<SamlPreferences>): Promise<SamlPreferences> {
		await this.ensureLibs();

		const merged: SamlPreferences = { ...this._samlPreferences, ...prefs };

		const signing = await this.resolveSigningMaterial(prefs, merged.authnRequestsSigned);
		merged.signingPrivateKey = signing.encryptedPrivateKey;
		merged.signingCertificate = signing.certificate;

		if (prefs.metadataUrl !== undefined && prefs.metadataUrl !== '') {
			merged.metadata = await this.fetchAndValidateMetadata(prefs.metadataUrl, merged.ignoreSSL);
			merged.metadataUrl = prefs.metadataUrl;
		} else {
			if (prefs.metadataUrl === '') merged.metadataUrl = undefined;
			if (prefs.metadata) await this.assertValidMetadata(prefs.metadata);
		}

		// state changes only after all validation has passed
		if (prefs.loginEnabled !== undefined) {
			try {
				await setSamlLoginEnabled(prefs.loginEnabled);
			} catch (error) {
				throw new BadRequestError(
					error instanceof Error ? error.message : 'Cannot change SAML login state',
				);
			}
		}
		if (prefs.loginLabel !== undefined) setSamlLoginLabel(prefs.loginLabel);
		merged.loginEnabled = isSamlLoginEnabled();

		this._samlPreferences = merged;
		this.identityProviderInstance = undefined;
		await this.saveSamlPreferencesToDb();
		return this.samlPreferences;
	}

	async reset(): Promise<void> {
		this._samlPreferences = defaultSamlPreferences();
		this.identityProviderInstance = undefined;
		this.pendingTestConfigs.clear();
		await this.settingsRepository.deleteByKey(SAML_PREFERENCES_DB_KEY);
	}

	/** Fetch IdP metadata over HTTP and reject anything that is not valid SAML metadata. */
	async fetchMetadataFromUrl(url: string): Promise<string> {
		return await this.fetchAndValidateMetadata(url, this._samlPreferences.ignoreSSL);
	}

	/** Serialized SP metadata XML reflecting the current preferences. */
	async getServiceProviderMetadata(): Promise<string> {
		const sp = await this.createServiceProvider(this._samlPreferences);
		return sp.getMetadata();
	}

	/**
	 * Build the login initiation value for the configured binding: the IdP
	 * redirect URL (redirect binding) or a self-submitting form (POST binding).
	 */
	async getLoginRequest(relayState = ''): Promise<string> {
		const idp = await this.getIdentityProviderInstance();
		return await this.createLoginRequest(idp, this._samlPreferences, relayState);
	}

	/**
	 * Start a connection test from unsaved preferences: retain them under an
	 * opaque single-use hex token and point RelayState at the test return URL.
	 */
	async createConnectionTestRequest(prefs: Partial<SamlPreferences>): Promise<string> {
		const samlify = await this.ensureLibs();

		const testPreferences: SamlPreferences = { ...this._samlPreferences, ...prefs };
		if (prefs.metadataUrl && !prefs.metadata) {
			testPreferences.metadata = await this.fetchAndValidateMetadata(
				prefs.metadataUrl,
				testPreferences.ignoreSSL,
			);
		}
		if (!testPreferences.metadata) {
			throw new BadRequestError('SAML metadata is required to test the connection');
		}
		await this.assertValidMetadata(testPreferences.metadata);

		const idp = samlify.IdentityProvider({ metadata: testPreferences.metadata });
		this.validator.validateIdentityProvider(idp);

		this.evictExpiredTestConfigs();
		const testId = randomBytes(16).toString('hex');
		this.pendingTestConfigs.set(testId, {
			preferences: testPreferences,
			expiresAt: Date.now() + PENDING_TEST_CONFIG_TTL_MS,
		});

		const relayState = `${getServiceProviderConfigTestReturnUrl()}?t=${testId}`;
		return await this.createLoginRequest(idp, testPreferences, relayState);
	}

	/** Single-use lookup of a retained connection-test configuration. */
	async consumePendingTestConfig(testId: string): Promise<SamlPreferences | undefined> {
		const entry = this.pendingTestConfigs.get(testId);
		this.pendingTestConfigs.delete(testId);
		if (!entry || entry.expiresAt < Date.now()) return undefined;
		return entry.preferences;
	}

	/**
	 * Parse a connection-test assertion against the retained test config.
	 * Returns partial results so the test page can show what the IdP sent.
	 */
	async getConnectionTestAttributes(
		req: express.Request,
		binding: SamlLoginBinding,
		testPreferences: SamlPreferences,
	): Promise<MappedAttributesResult> {
		const samlify = await this.ensureLibs();
		if (!testPreferences.metadata) {
			throw new BadRequestError('SAML metadata is required to test the connection');
		}
		const idp = samlify.IdentityProvider({ metadata: testPreferences.metadata });
		this.validator.validateIdentityProvider(idp);
		return await this.extractAttributes(req, binding, testPreferences, idp);
	}

	/** Parse and map the assertion of a normal login; throws on missing required attributes. */
	async getAttributesFromLoginResponse(
		req: express.Request,
		binding: SamlLoginBinding,
	): Promise<{ mapped: SamlUserAttributes; raw: Record<string, unknown> }> {
		const idp = await this.getIdentityProviderInstance();
		const result = await this.extractAttributes(req, binding, this._samlPreferences, idp);
		if (!result.attributes || result.missingAttributes.length > 0) {
			throw new AuthError(
				`SAML login failed: The SAML response is missing required attributes (${result.missingAttributes.join(', ')})`,
			);
		}
		return { mapped: result.attributes, raw: result.rawAttributes };
	}

	/**
	 * Consume a login assertion and sign the user in: existing accounts get
	 * their SAML identity and names refreshed, unknown users are provisioned
	 * just-in-time when enabled.
	 */
	async handleSamlLogin(
		req: express.Request,
		binding: SamlLoginBinding,
	): Promise<{ attributes: SamlUserAttributes; authenticatedUser?: User }> {
		const { mapped } = await this.getAttributesFromLoginResponse(req, binding);

		// validation is case-insensitive but the IdP's casing is preserved in the result
		const lowerCasedEmail = mapped.email?.toLowerCase();
		if (!lowerCasedEmail || !EMAIL_REGEX.test(lowerCasedEmail)) {
			throw new BadRequestError('Invalid email format');
		}

		const user = await this.userRepository.findOne({
			where: { email: lowerCasedEmail },
			relations: ['authIdentities', 'role'],
		});

		if (user) {
			return {
				authenticatedUser: await updateUserFromSamlAttributes(user, mapped),
				attributes: mapped,
			};
		}

		if (!this.globalConfig.sso.justInTimeProvisioning) {
			throw new AuthError(
				'SAML login failed: user does not exist and JIT provisioning is disabled',
			);
		}

		return {
			authenticatedUser: await createUserFromSamlAttributes(mapped),
			attributes: mapped,
		};
	}

	private async saveSamlPreferencesToDb(): Promise<void> {
		await this.settingsRepository.save({
			key: SAML_PREFERENCES_DB_KEY,
			value: JSON.stringify(this._samlPreferences),
			loadOnStartup: true,
		});
	}

	private async getIdentityProviderInstance(): Promise<IdentityProviderInstance> {
		const samlify = await this.ensureLibs();
		const { metadata } = this._samlPreferences;
		if (!metadata) throw new AuthError('SAML login failed: No IdP metadata configured');
		if (!this.identityProviderInstance) {
			this.identityProviderInstance = samlify.IdentityProvider({ metadata });
			this.validator.validateIdentityProvider(this.identityProviderInstance);
		}
		return this.identityProviderInstance;
	}

	private async createServiceProvider(prefs: SamlPreferences): Promise<ServiceProviderInstance> {
		const samlify = await this.ensureLibs();
		return createServiceProviderInstance(
			prefs,
			samlify,
			await this.getDecryptedSigningPrivateKey(),
		);
	}

	private async createLoginRequest(
		idp: IdentityProviderInstance,
		prefs: SamlPreferences,
		relayState: string,
	): Promise<string> {
		const sp = await this.createServiceProvider(prefs);
		const binding = prefs.loginBinding === 'post' ? 'post' : 'redirect';
		// RelayState is request-scoped; it must be passed per request, never stored on the entity
		const context = sp.createLoginRequest(idp, binding, relayState ? { relayState } : {});
		if (binding === 'post') {
			if ('entityEndpoint' in context) return getInitSSOFormView(context);
			throw new UnexpectedError('Failed to create SAML POST binding login request');
		}
		return context.context;
	}

	private async extractAttributes(
		req: express.Request,
		binding: SamlLoginBinding,
		prefs: SamlPreferences,
		idp: IdentityProviderInstance,
	): Promise<MappedAttributesResult> {
		const sp = await this.createServiceProvider(prefs);
		const flowResult = await sp.parseLoginResponse(idp, binding, toEsamlHttpRequest(req));

		const provisioningConfig = await this.provisioningService.getProvisioningConfig();
		const jitClaimNames = {
			instanceRole: provisioningConfig.scopesProvisionInstanceRole
				? provisioningConfig.scopesInstanceRoleClaimName
				: null,
			projectRoles: provisioningConfig.scopesProvisionProjectRoles
				? provisioningConfig.scopesProjectsRolesClaimName
				: null,
		};

		const mapping = prefs.mapping ?? {
			email: '',
			firstName: '',
			lastName: '',
			userPrincipalName: '',
		};
		return getMappedSamlAttributesFromFlowResult(flowResult, mapping, jitClaimNames);
	}

	private async getDecryptedSigningPrivateKey(): Promise<string | undefined> {
		const encrypted = this._samlPreferences.signingPrivateKey;
		if (!encrypted) return undefined;
		try {
			return this.cipher.decrypt(encrypted);
		} catch (error) {
			this.logger.warn(
				`Failed to decrypt SAML signing private key: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	/**
	 * Resolve the signing key/certificate update: `''` clears a value, the
	 * blanking placeholder keeps the stored one, anything else is new material
	 * (feature-gated, format-checked, pair-checked, key encrypted at rest).
	 */
	private async resolveSigningMaterial(
		update: Partial<SamlPreferences>,
		authnRequestsSigned: boolean,
	): Promise<{ encryptedPrivateKey?: string; certificate?: string }> {
		const currentEncryptedKey = this._samlPreferences.signingPrivateKey;
		const currentCertificate = this._samlPreferences.signingCertificate;

		const { newValue: newPrivateKey, clear: clearPrivateKey } = parseSecretUpdate(
			update.signingPrivateKey,
		);
		const { newValue: newCertificate, clear: clearCertificate } = parseSecretUpdate(
			update.signingCertificate,
		);

		if (
			(newPrivateKey !== undefined || newCertificate !== undefined) &&
			process.env.N8N_ENV_FEAT_SIGNED_SAML_REQUESTS !== 'true'
		) {
			throw new BadRequestError(
				'SAML request signing is not enabled. Set N8N_ENV_FEAT_SIGNED_SAML_REQUESTS=true to configure signing keys.',
			);
		}

		assertPemFormats(newPrivateKey, newCertificate);

		const effectivePlainKey =
			newPrivateKey ?? (clearPrivateKey ? undefined : await this.getDecryptedSigningPrivateKey());
		const effectiveCertificate =
			newCertificate ?? (clearCertificate ? undefined : currentCertificate);

		if (effectivePlainKey && effectiveCertificate) {
			let matches: boolean;
			try {
				matches = new X509Certificate(effectiveCertificate).checkPrivateKey(
					createPrivateKey(effectivePlainKey),
				);
			} catch {
				matches = false;
			}
			if (!matches) {
				throw new BadRequestError('The signing private key and signing certificate do not match');
			}
		}

		if (authnRequestsSigned && !(effectivePlainKey && effectiveCertificate)) {
			throw new BadRequestError(
				'Both signingPrivateKey and signingCertificate are required to sign SAML requests',
			);
		}

		const encryptedPrivateKey =
			newPrivateKey !== undefined
				? this.cipher.encrypt(newPrivateKey)
				: clearPrivateKey
					? undefined
					: currentEncryptedKey;

		return { encryptedPrivateKey, certificate: effectiveCertificate };
	}

	private async fetchAndValidateMetadata(url: string, ignoreSSL: boolean): Promise<string> {
		await this.ensureLibs();

		let fetched: unknown;
		try {
			fetched = await this.outboundHttp.requests().request<string>({
				url,
				method: 'GET',
				skipSslCertificateValidation: ignoreSSL,
				timeout: METADATA_FETCH_TIMEOUT_MS,
			});
		} catch (error) {
			this.logger.debug(
				`SAML metadata fetch from ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new BadRequestError(`Failed to produce valid SAML metadata from ${url}`);
		}

		if (typeof fetched !== 'string' || !(await this.isValidMetadata(fetched))) {
			throw new BadRequestError(`Failed to produce valid SAML metadata from ${url}`);
		}
		return fetched;
	}

	private async isValidMetadata(metadata: string): Promise<boolean> {
		try {
			return await this.validator.validateMetadata(metadata);
		} catch {
			return false;
		}
	}

	private async assertValidMetadata(metadata: string): Promise<void> {
		try {
			if (await this.validator.validateMetadata(metadata)) return;
		} catch (error) {
			throw new BadRequestError(error instanceof Error ? error.message : 'Invalid SAML metadata');
		}
		throw new BadRequestError('Invalid SAML metadata');
	}

	private evictExpiredTestConfigs(): void {
		const now = Date.now();
		for (const [testId, entry] of this.pendingTestConfigs) {
			if (entry.expiresAt < now) this.pendingTestConfigs.delete(testId);
		}
	}
}
