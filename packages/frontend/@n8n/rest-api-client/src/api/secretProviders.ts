import type { SecretProviderConnection } from '@n8n/api-types';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

/** Secret-provider connections a project may draw secrets from. */
export async function getProjectSecretProviderConnectionsByProjectId(
	context: IRestApiContext,
	projectId: string,
): Promise<SecretProviderConnection[]> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/secret-providers/projects/${projectId}/connections`,
	);
}
