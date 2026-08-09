import type { RequestHandler } from 'express';

import { isSamlLicensed, isSamlLicensedAndEnabled } from '@/sso/sso-helpers';

import { isConnectionTestRequest } from '../saml-helpers';

/**
 * ACS also accepts connection-test callbacks while SAML is licensed but not yet
 * enabled — testing a configuration before turning it on is the point of the
 * test flow. Such callbacks are recognised by a single-use token in RelayState
 * and render a result page; they never issue a session.
 */
export const samlLicensedAndEnabledOrConnectionTestMiddleware: RequestHandler = (
	req,
	res,
	next,
) => {
	if (isSamlLicensedAndEnabled()) {
		next();
		return;
	}

	const payload = (req.method === 'GET' ? req.query : req.body) as { RelayState?: string };
	if (isSamlLicensed() && payload?.RelayState && isConnectionTestRequest(payload)) {
		next();
		return;
	}

	res.status(403).json({ status: 'error', message: 'Unauthorized' });
};

export const samlLicensedAndEnabledMiddleware: RequestHandler = (_, res, next) => {
	if (isSamlLicensedAndEnabled()) {
		next();
	} else {
		res.status(403).json({ status: 'error', message: 'Unauthorized' });
	}
};

export const samlLicensedMiddleware: RequestHandler = (_, res, next) => {
	if (isSamlLicensed()) {
		next();
	} else {
		res.status(403).json({ status: 'error', message: 'Unauthorized' });
	}
};
