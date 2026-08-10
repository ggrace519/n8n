import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import type { SecretCompletionsResponse } from '@n8n/api-types';
import type { IDataObject } from 'n8n-workflow';

import { EXTERNAL_SECRETS_API_ROOT, SECRET_PROVIDERS_API_ROOT } from './externalSecrets.constants';
import type { ExternalSecretsProvider } from './externalSecrets.types';

export async function getExternalSecretsProviders(
	context: IRestApiContext,
): Promise<ExternalSecretsProvider[]> {
	return await makeRestApiRequest(context, 'GET', `/${EXTERNAL_SECRETS_API_ROOT}/providers`);
}

export async function getExternalSecretsProvider(
	context: IRestApiContext,
	name: string,
): Promise<ExternalSecretsProvider> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/${EXTERNAL_SECRETS_API_ROOT}/providers/${name}`,
	);
}

export async function setExternalSecretsProviderSettings(
	context: IRestApiContext,
	name: string,
	data: IDataObject,
): Promise<{ updated: true }> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/${EXTERNAL_SECRETS_API_ROOT}/providers/${name}`,
		data,
	);
}

export async function setExternalSecretsProviderConnected(
	context: IRestApiContext,
	name: string,
	connected: boolean,
): Promise<{ updated: true }> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/${EXTERNAL_SECRETS_API_ROOT}/providers/${name}/connect`,
		{ connected },
	);
}

export async function testExternalSecretsProviderSettings(
	context: IRestApiContext,
	name: string,
	data: IDataObject,
): Promise<{ success: boolean; testState: 'connected' | 'error' }> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/${EXTERNAL_SECRETS_API_ROOT}/providers/${name}/test`,
		data,
	);
}

export async function reloadExternalSecretsProvider(
	context: IRestApiContext,
	name: string,
): Promise<{ updated: boolean }> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/${EXTERNAL_SECRETS_API_ROOT}/providers/${name}/update`,
	);
}

export async function getExternalSecretNames(
	context: IRestApiContext,
): Promise<Record<string, string[]>> {
	return await makeRestApiRequest(context, 'GET', `/${EXTERNAL_SECRETS_API_ROOT}/secrets`);
}

export async function getGlobalSecretsForProject(
	context: IRestApiContext,
	projectId: string,
): Promise<SecretCompletionsResponse> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/${SECRET_PROVIDERS_API_ROOT}/completions/secrets/global/${projectId}`,
	);
}

export async function getProjectSecrets(
	context: IRestApiContext,
	projectId: string,
): Promise<SecretCompletionsResponse> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/${SECRET_PROVIDERS_API_ROOT}/completions/secrets/project/${projectId}`,
	);
}
