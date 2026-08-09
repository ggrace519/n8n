import { SamlPreferences, SamlToggleDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Post, RestController } from '@n8n/decorators';
import type express from 'express';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { EventService } from '@/events/event.service';
import type { AuthlessRequest } from '@/requests';
import { UrlService } from '@/services/url.service';

import {
	samlLicensedAndEnabledMiddleware,
	samlLicensedAndEnabledOrConnectionTestMiddleware,
	samlLicensedMiddleware,
} from './middleware/saml-enabled-middleware';
import { extractTestIdFromRelayState, isConnectionTestRequest } from './saml-helpers';
import { SamlService } from './saml.service';
import { getServiceProviderEntityId, getServiceProviderReturnUrl } from './service-provider';
import type { SamlLoginBinding } from './types';

@RestController('/sso/saml')
export class SamlController {
	constructor(
		private readonly logger: Logger,
		private readonly samlService: SamlService,
		private readonly authService: AuthService,
		private readonly eventService: EventService,
		private readonly urlService: UrlService,
	) {}

	/** Public SP metadata document; IdPs fetch this URL to configure trust. */
	@Get('/metadata', { skipAuth: true, usesTemplates: true, middlewares: [samlLicensedMiddleware] })
	async getServiceProviderMetadata(_req: AuthlessRequest, res: express.Response) {
		try {
			const metadata = await this.samlService.getServiceProviderMetadata();
			res.header('content-type', 'text/xml').send(metadata);
		} catch (error) {
			this.logger.error(
				`Failed to generate SAML SP metadata: ${error instanceof Error ? error.message : String(error)}`,
			);
			res.status(500).send('Failed to generate SAML service provider metadata');
		}
	}

	@Get('/config', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	configGet() {
		return this.toConfigResponse(this.samlService.samlPreferences);
	}

	@Post('/config', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async configPost(
		_req: AuthenticatedRequest,
		_res: express.Response,
		@Body payload: SamlPreferences,
	) {
		const updated = await this.samlService.setSamlPreferences(payload);
		return this.toConfigResponse(updated);
	}

	@Post('/config/toggle', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async toggleEnabledPost(
		_req: AuthenticatedRequest,
		_res: express.Response,
		@Body payload: SamlToggleDto,
	) {
		await this.samlService.setSamlPreferences({ loginEnabled: payload.loginEnabled });
	}

	/** Start a connection test against unsaved preferences; returns the IdP login-init value. */
	@Post('/config/test', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async configTestPost(
		_req: AuthenticatedRequest,
		_res: express.Response,
		@Body payload: SamlPreferences,
	) {
		return await this.samlService.createConnectionTestRequest(payload);
	}

	/** Login initiation: IdP redirect URL, or a self-submitting form for the POST binding. */
	@Get('/initsso', { skipAuth: true, middlewares: [samlLicensedAndEnabledMiddleware] })
	async initSsoGet(req: AuthlessRequest<{}, {}, {}, { redirect?: string }>, res: express.Response) {
		const redirect = typeof req.query.redirect === 'string' ? req.query.redirect : '';
		return await this.samlService.getLoginRequest(this.toSafeLocalPath(redirect), res);
	}

	@Get('/acs', {
		skipAuth: true,
		usesTemplates: true,
		middlewares: [samlLicensedAndEnabledOrConnectionTestMiddleware],
	})
	async acsGet(req: AuthlessRequest, res: express.Response) {
		await this.handleAcs(req, res, 'redirect');
	}

	@Post('/acs', {
		skipAuth: true,
		usesTemplates: true,
		middlewares: [samlLicensedAndEnabledOrConnectionTestMiddleware],
	})
	async acsPost(req: AuthlessRequest, res: express.Response) {
		await this.handleAcs(req, res, 'post');
	}

	private async handleAcs(req: AuthlessRequest, res: express.Response, binding: SamlLoginBinding) {
		const relayState = this.getRelayState(req, binding);
		// the login flow ends here either way, so the flow cookie is spent
		this.samlService.clearFlowCookie(res);

		// A connection test always renders a result page with HTTP 200, even on failure.
		if (isConnectionTestRequest({ RelayState: relayState })) {
			await this.renderConnectionTestResult(req, res, binding, relayState);
			return;
		}

		try {
			const loginResult = await this.samlService.handleSamlLogin(req, binding);
			if (loginResult.authenticatedUser) {
				this.authService.issueCookie(res, loginResult.authenticatedUser, false, req.browserId);
				this.eventService.emit('user-logged-in', {
					user: loginResult.authenticatedUser,
					authenticationMethod: 'saml',
				});
				res.redirect(303, this.getRedirectTarget(relayState));
				return;
			}
		} catch (error) {
			this.logger.warn(
				`SAML login failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		res.status(401).send('SAML Authentication failed');
	}

	private async renderConnectionTestResult(
		req: AuthlessRequest,
		res: express.Response,
		binding: SamlLoginBinding,
		relayState: string | undefined,
	) {
		try {
			const testId = extractTestIdFromRelayState(relayState);
			const testConfig = testId
				? await this.samlService.consumePendingTestConfig(testId)
				: undefined;
			if (!testConfig) {
				res.render('saml-connection-test-failed', {
					message:
						'The connection test session has expired or was already used. Please run the test again.',
				});
				return;
			}

			const result = await this.samlService.getConnectionTestAttributes(req, binding, testConfig);
			const rawAttributesJson = JSON.stringify(result.rawAttributes, null, 2);
			if (result.attributes?.email) {
				res.render('saml-connection-test-success', { ...result.attributes, rawAttributesJson });
			} else {
				res.render('saml-connection-test-failed', {
					attributes: result.attributes,
					rawAttributesJson,
				});
			}
		} catch (error) {
			this.logger.warn(
				`SAML connection test failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			res.render('saml-connection-test-failed', {});
		}
	}

	private toConfigResponse(prefs: SamlPreferences) {
		return {
			...prefs,
			// the private key never leaves the backend; the certificate is public material
			signingPrivateKey: prefs.signingPrivateKey ? CREDENTIAL_BLANKING_VALUE : undefined,
			entityID: getServiceProviderEntityId(),
			returnUrl: getServiceProviderReturnUrl(),
		};
	}

	private getRelayState(req: express.Request, binding: SamlLoginBinding): string | undefined {
		const source: unknown = binding === 'post' ? req.body : req.query;
		if (typeof source !== 'object' || source === null) return undefined;
		const record: Record<string, unknown> = { ...source };
		const value = record.RelayState;
		return typeof value === 'string' ? value : undefined;
	}

	/** Only same-origin relative paths may be used as post-login redirect targets. */
	private toSafeLocalPath(candidate: string): string {
		return candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')
			? candidate
			: '';
	}

	private getRedirectTarget(relayState: string | undefined): string {
		const base = this.urlService.getInstanceBaseUrl();
		const path = this.toSafeLocalPath(relayState ?? '');
		return `${base}${path}`;
	}
}
