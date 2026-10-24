import type { WorkflowExecutionStatus } from '@n8n/api-types';
import { AuthenticatedRequest, type User } from '@n8n/db';
import { Delete, Get, Param, Post, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { AuthService } from '@/auth/auth.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { UnauthenticatedError } from '@/errors/response-errors/unauthenticated.error';

import { DynamicCredentialsConfig } from './dynamic-credentials.config';
import {
	type CallerIdentity,
	DynamicCredentialAuthorizationService,
} from './services/dynamic-credential-authorization.service';

/** Header an external caller presents the static endpoint token in. */
const ENDPOINT_TOKEN_HEADER = 'x-authorization';

type DynamicCredentialsQuery = { resolverId?: string; authSource?: string; token?: string };

/**
 * `@Query` only parses into Zod DTO classes, so read the few string params here.
 * Repeated or nested values (arrays/objects) are ignored.
 */
function readQuery(req: Request): DynamicCredentialsQuery {
	const pick = (key: string) => {
		const value: unknown = req.query[key];
		return typeof value === 'string' ? value : undefined;
	};
	return { resolverId: pick('resolverId'), authSource: pick('authSource'), token: pick('token') };
}

/**
 * Endpoints that let an end user — signed in to n8n, or external and named by a
 * Bearer token — see which credentials a workflow still needs, connect one
 * through OAuth, and disconnect it. See `.defork/e12b-contract.md`.
 *
 * Access: a valid n8n session, or the static `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN`
 * in `X-Authorization`. With no token configured only sessions are admitted.
 */
@RestController('/')
export class DynamicCredentialsController {
	constructor(
		private readonly config: DynamicCredentialsConfig,
		private readonly authService: AuthService,
		private readonly authorizationService: DynamicCredentialAuthorizationService,
	) {}

	@Get('/workflows/:workflowId/execution-status', { allowUnauthenticated: true })
	async getExecutionStatus(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
	): Promise<WorkflowExecutionStatus> {
		const query = readQuery(req);
		return await this.authorizationService.getExecutionStatus(
			workflowId,
			this.identify(req, query),
		);
	}

	@Post('/credentials/:credentialId/authorize', { allowUnauthenticated: true })
	async authorize(
		req: AuthenticatedRequest,
		res: Response,
		@Param('credentialId') credentialId: string,
	): Promise<string> {
		const query = readQuery(req);
		const identity = this.identify(req, query);
		return await this.authorizationService.startAuthorization(
			credentialId,
			requireResolverId(query),
			identity,
			// A signed-in browser opens the provider URL itself, so bind the flow to it.
			identity.kind === 'user' ? { req, res } : undefined,
		);
	}

	/**
	 * Opens a gate-issued single-use link: admitted by the link token, and — for a
	 * link minted for an n8n user — only in that user's signed-in session.
	 */
	@Get('/credentials/:credentialId/authorize', { allowUnauthenticated: true })
	async followAuthorizeLink(
		req: AuthenticatedRequest,
		res: Response,
		@Param('credentialId') credentialId: string,
	): Promise<void> {
		const query = readQuery(req);
		if (typeof query.token !== 'string' || query.token.length === 0) {
			throw new BadRequestError('An authorization link token is required');
		}
		const providerUrl = await this.authorizationService.consumeAuthorizeLink(
			credentialId,
			query.token,
			{ req, res },
			req.user,
		);
		// The link token is in this URL: keep it out of caches and Referer headers.
		res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('Cache-Control', 'no-store');
		res.redirect(providerUrl);
	}

	@Delete('/credentials/:credentialId/revoke', { allowUnauthenticated: true })
	async revoke(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('credentialId') credentialId: string,
	): Promise<{ success: true }> {
		const query = readQuery(req);
		await this.authorizationService.revoke(
			credentialId,
			requireResolverId(query),
			this.identify(req, query),
		);
		return { success: true };
	}

	/**
	 * Admits the request and says who it acts for: the session user when
	 * `authSource=cookie` or no Bearer is sent, otherwise the external user the
	 * Bearer token names (verified later by the resolver).
	 */
	private identify(req: AuthenticatedRequest, query: DynamicCredentialsQuery): CallerIdentity {
		// `allowUnauthenticated` routes leave `req.user` unset without a session.
		const user: User | undefined = req.user;
		if (!user && !this.hasValidEndpointToken(req)) throw new UnauthenticatedError();

		const bearer = req.headers.authorization;
		const wantsSession = query.authSource === 'cookie' || typeof bearer !== 'string';

		if (wantsSession) {
			const cookieToken = this.authService.getCookieToken(req);
			if (!user || !cookieToken) throw new UnauthenticatedError();
			return { kind: 'user', user, cookieToken };
		}

		if (!/^Bearer\s+\S+$/i.test(bearer)) throw new UnauthenticatedError();
		return { kind: 'external', authorizationHeader: bearer.trim(), sessionUser: user };
	}

	private hasValidEndpointToken(req: Request): boolean {
		const expected = this.config.endpointAuthToken.trim();
		if (!expected) return false;

		const header = req.headers[ENDPOINT_TOKEN_HEADER];
		if (typeof header !== 'string') return false;
		const presented = header.trim().replace(/^Bearer\s+/i, '');

		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	}
}

function requireResolverId({ resolverId }: DynamicCredentialsQuery): string {
	if (typeof resolverId !== 'string' || resolverId.length === 0) {
		throw new BadRequestError('resolverId is required');
	}
	return resolverId;
}
