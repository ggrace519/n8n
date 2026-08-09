import type { User } from '@n8n/db';
import type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationWebhookOptions,
} from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';

import type { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';

import { isSupportedGenericAuthType } from './constants';

/**
 * Validate and normalize the credential binding of destination options before
 * they are persisted.
 *
 * Only a webhook destination with `genericCredentialType` authentication may
 * carry a credential reference, and only when the requesting user can read the
 * referenced credential and its stored type matches the configured generic
 * auth type. Everything else is rejected (unsupported modes) or stripped
 * (stray references), so only validated bindings are ever persisted — the
 * delivery path then fails closed on anything it cannot resolve.
 */
export async function validateDestinationCredentials(
	options: MessageEventBusDestinationOptions,
	user: User,
	credentialsFinder: CredentialsFinderService,
): Promise<MessageEventBusDestinationOptions> {
	if (options.__type !== MessageEventBusDestinationTypeNames.webhook) {
		return { ...options, credentials: {} };
	}

	const webhook = options as MessageEventBusDestinationWebhookOptions;
	const authentication = webhook.authentication ?? 'none';

	if (authentication === 'none') {
		return { ...webhook, credentials: {} };
	}

	if (authentication !== 'genericCredentialType') {
		throw new BadRequestError(
			`Authentication mode "${authentication}" is not supported for log streaming destinations`,
		);
	}

	const genericAuthType = webhook.genericAuthType ?? '';
	if (!isSupportedGenericAuthType(genericAuthType)) {
		throw new BadRequestError(
			`Authentication type "${genericAuthType}" is not supported for log streaming destinations`,
		);
	}

	const reference = webhook.credentials?.[genericAuthType];
	if (!reference?.id) {
		throw new BadRequestError(
			`A "${genericAuthType}" credential must be provided for the selected authentication type`,
		);
	}

	const credential = await credentialsFinder.findCredentialForUser(reference.id, user, [
		'credential:read',
	]);
	if (!credential) {
		throw new ForbiddenError('The referenced credential could not be found or accessed');
	}
	if (credential.type !== genericAuthType) {
		throw new BadRequestError(
			'The referenced credential does not match the selected authentication type',
		);
	}

	return {
		...webhook,
		credentials: { [genericAuthType]: { id: credential.id, name: credential.name } },
	};
}
