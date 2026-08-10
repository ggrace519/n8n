import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import { LOG_STREAMING_API_ROOT } from './logStreaming.constants';
import type { MessageEventBusDestinationOptions } from './logStreaming.types';

/**
 * Fetch all configured log-stream destinations, or a single one when `id` is
 * given. Maps to `GET /rest/eventbus/destination`.
 */
export const getDestinations = async (
	context: IRestApiContext,
	id?: string,
): Promise<MessageEventBusDestinationOptions[]> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`${LOG_STREAMING_API_ROOT}/destination`,
		id ? { id } : undefined,
	);
};

/**
 * Create or update a destination. The backend upserts by `id`, so the same
 * endpoint serves both cases. Maps to `POST /rest/eventbus/destination`.
 */
export const saveDestination = async (
	context: IRestApiContext,
	destination: MessageEventBusDestinationOptions,
): Promise<MessageEventBusDestinationOptions> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`${LOG_STREAMING_API_ROOT}/destination`,
		destination,
	);
};

/** Delete a destination by id. Maps to `DELETE /rest/eventbus/destination`. */
export const deleteDestination = async (
	context: IRestApiContext,
	id: string,
): Promise<{ success: boolean }> => {
	return await makeRestApiRequest(context, 'DELETE', `${LOG_STREAMING_API_ROOT}/destination`, {
		id,
	});
};

/**
 * Ask the backend to emit a test message to the given destination. Maps to
 * `GET /rest/eventbus/testmessage`. Resolves to whether the test succeeded.
 */
export const sendTestMessage = async (context: IRestApiContext, id: string): Promise<boolean> => {
	return await makeRestApiRequest(context, 'GET', `${LOG_STREAMING_API_ROOT}/testmessage`, {
		id,
	});
};
