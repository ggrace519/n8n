import type { ICredentialsResponse } from './credentials.types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * Credential sharing & transfer API calls.
 *
 * Backend routes (see cli `credentials.controller`):
 * - PUT /credentials/:credentialId/share    { shareWithIds }
 * - PUT /credentials/:credentialId/transfer { destinationProjectId }
 */

export async function setCredentialSharedWith(
	context: IRestApiContext,
	credentialId: string,
	data: { shareWithIds: string[] },
): Promise<ICredentialsResponse> {
	return await makeRestApiRequest<ICredentialsResponse>(
		context,
		'PUT',
		`/credentials/${credentialId}/share`,
		data,
	);
}

export async function moveCredentialToProject(
	context: IRestApiContext,
	credentialId: string,
	destinationProjectId: string,
): Promise<void> {
	await makeRestApiRequest(context, 'PUT', `/credentials/${credentialId}/transfer`, {
		destinationProjectId,
	});
}
