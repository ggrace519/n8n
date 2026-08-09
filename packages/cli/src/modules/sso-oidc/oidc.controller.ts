import { OidcConfigDto, TestOidcConfigResponseDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Licensed, Post, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { AuthService } from '@/auth/auth.service';
import { ResponseError } from '@/errors/response-errors/abstract/response.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { EventService } from '@/events/event.service';
import type { AuthlessRequest } from '@/requests';
import { UrlService } from '@/services/url.service';

import { OidcService } from './oidc.service';

@RestController('/sso/oidc')
export class OidcController {
	constructor(
		private readonly logger: Logger,
		private readonly oidcService: OidcService,
		private readonly authService: AuthService,
		private readonly eventService: EventService,
		private readonly urlService: UrlService,
	) {}

	@Get('/config')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async getConfig() {
		return await this.oidcService.loadConfigForResponse();
	}

	@Post('/config')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async updateConfig(_req: AuthenticatedRequest, _res: Response, @Body payload: OidcConfigDto) {
		await this.oidcService.updateConfig(payload);
		return await this.oidcService.loadConfigForResponse();
	}

	@Post('/config/test')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async testConfig(_req: AuthenticatedRequest, res: Response): Promise<TestOidcConfigResponseDto> {
		try {
			const url = await this.oidcService.createAuthorizationUrl(res, { connectionTest: true });
			return { url };
		} catch (error) {
			if (error instanceof ResponseError) throw error;
			throw new BadRequestError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Returns the provider authorization URL that starts an OIDC login. */
	@Get('/login', { skipAuth: true })
	@Licensed('feat:oidc')
	async login(_req: AuthlessRequest, res: Response): Promise<string> {
		if (!this.oidcService.isOidcLoginActive()) {
			throw new ForbiddenError('OIDC login is not enabled');
		}
		return await this.oidcService.createAuthorizationUrl(res);
	}

	/**
	 * Authorization-response callback for both normal logins and connection
	 * tests. `usesTemplates` responses are written directly, so every branch —
	 * including errors — must answer here.
	 */
	@Get('/callback', { skipAuth: true, usesTemplates: true })
	@Licensed('feat:oidc')
	async handleCallback(req: AuthlessRequest, res: Response) {
		if (this.oidcService.consumePendingTestCallback(req)) {
			// Connection tests always render a result page with HTTP 200.
			res.send(await this.oidcService.runConnectionTestCallback(req, res));
			return;
		}

		try {
			const { user, idToken } = await this.oidcService.runLoginCallback(req, res);
			this.authService.issueCookie(res, user, false, req.browserId);
			this.eventService.emit('user-logged-in', { user, authenticationMethod: 'oidc' });
			await this.oidcService.setIdTokenCookie(res, idToken);
			res.redirect(this.urlService.getInstanceBaseUrl());
		} catch (error) {
			this.logger.error('OIDC login callback failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			res.status(401).send('OIDC Authentication failed');
		}
	}

	/**
	 * Ends the n8n session and, when possible, returns the provider's
	 * RP-Initiated Logout URL. The local session always ends, even when no
	 * provider redirect can be built.
	 */
	@Post('/logout')
	async logout(req: AuthenticatedRequest, res: Response) {
		const redirectUrl = await this.oidcService.createLogoutRedirectUrl(req);
		await this.authService.invalidateToken(req);
		this.authService.clearCookie(res);
		this.oidcService.clearIdTokenCookie(res);
		return { redirectUrl };
	}
}
