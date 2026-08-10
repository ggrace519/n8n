import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import { VARIABLES_API_ROOT } from './environments.constants';
import type {
	CreateEnvironmentVariablePayload,
	EnvironmentVariable,
	UpdateEnvironmentVariablePayload,
} from './environments.types';

/** Options accepted by the variables list endpoint. */
export interface VariablesListOptions {
	/** `empty` returns only variables whose value is unset. */
	state?: 'empty';
	/** Narrows the result to a single project (omit for all visible variables). */
	projectId?: string;
}

export async function getVariables(
	context: IRestApiContext,
	options: VariablesListOptions = {},
): Promise<EnvironmentVariable[]> {
	return await makeRestApiRequest(context, 'GET', `/${VARIABLES_API_ROOT}`, { ...options });
}

export async function createVariable(
	context: IRestApiContext,
	payload: CreateEnvironmentVariablePayload,
): Promise<EnvironmentVariable> {
	return await makeRestApiRequest(context, 'POST', `/${VARIABLES_API_ROOT}`, { ...payload });
}

export async function updateVariable(
	context: IRestApiContext,
	{ id, ...payload }: UpdateEnvironmentVariablePayload,
): Promise<EnvironmentVariable> {
	return await makeRestApiRequest(context, 'PATCH', `/${VARIABLES_API_ROOT}/${id}`, { ...payload });
}

export async function deleteVariable(
	context: IRestApiContext,
	{ id }: Pick<EnvironmentVariable, 'id'>,
): Promise<void> {
	return await makeRestApiRequest(context, 'DELETE', `/${VARIABLES_API_ROOT}/${id}`);
}
