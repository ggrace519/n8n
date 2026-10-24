import type { Logger } from '@n8n/backend-common';
import type { Response } from 'express';
import { mock } from 'vitest-mock-extended';

import type { AuthService } from '@/auth/auth.service';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import type { EventService } from '@/events/event.service';
import type { AuthlessRequest } from '@/requests';
import type { UrlService } from '@/services/url.service';

import { OidcController } from '../oidc.controller';
import type { OidcService } from '../oidc.service';

describe('OidcController.login', () => {
	const setup = (loginActive: boolean) => {
		const oidcService = mock<OidcService>();
		oidcService.isOidcLoginActive.mockReturnValue(loginActive);
		oidcService.createAuthorizationUrl.mockResolvedValue('https://idp.example.com/auth?state=s');
		const controller = new OidcController(
			mock<Logger>(),
			oidcService,
			mock<AuthService>(),
			mock<EventService>(),
			mock<UrlService>(),
		);
		return { controller, res: mock<Response>() };
	};

	it('redirects the browser to the provider, since the sign-in page navigates here', async () => {
		const { controller, res } = setup(true);

		await controller.login(mock<AuthlessRequest>(), res);

		expect(res.redirect).toHaveBeenCalledWith('https://idp.example.com/auth?state=s');
	});

	it('refuses when OIDC login is not enabled', async () => {
		const { controller, res } = setup(false);

		await expect(controller.login(mock<AuthlessRequest>(), res)).rejects.toThrow(ForbiddenError);
		expect(res.redirect).not.toHaveBeenCalled();
	});
});
