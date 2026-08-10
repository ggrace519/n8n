import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import { ORCHESTRATION_API_ROOT } from './orchestration.constants';

/**
 * Ask the backend to request status from all connected workers. This is a
 * fire-and-forget trigger: it returns nothing, and the workers' replies arrive
 * separately over the push connection as `sendWorkerStatusMessage` events.
 * Maps to `POST /rest/orchestration/worker/status`.
 */
export const getWorkerStatus = async (context: IRestApiContext): Promise<void> => {
	await makeRestApiRequest(context, 'POST', `${ORCHESTRATION_API_ROOT}/worker/status`);
};
