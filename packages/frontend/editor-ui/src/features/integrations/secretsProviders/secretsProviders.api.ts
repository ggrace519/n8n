import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import type {
	CreateSecretsProviderConnectionDto,
	SecretProviderConnection,
	SecretProviderConnectionListItem,
	SecretProviderTypeResponse,
	TestSecretProviderConnectionResponse,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';

import { SECRET_PROVIDERS_API_ROOT } from '../externalSecrets/externalSecrets.constants';

const root = `/${SECRET_PROVIDERS_API_ROOT}`;

// #region Provider types

export async function getProviderTypes(
	context: IRestApiContext,
): Promise<SecretProviderTypeResponse[]> {
	return await makeRestApiRequest(context, 'GET', `${root}/types`);
}

export async function getProviderType(
	context: IRestApiContext,
	type: string,
): Promise<SecretProviderTypeResponse> {
	return await makeRestApiRequest(context, 'GET', `${root}/types/${type}`);
}

// #endregion

// #region Instance-wide connections

export async function getConnections(
	context: IRestApiContext,
): Promise<SecretProviderConnectionListItem[]> {
	return await makeRestApiRequest(context, 'GET', `${root}/connections`);
}

export async function getConnection(
	context: IRestApiContext,
	providerKey: string,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(context, 'GET', `${root}/connections/${providerKey}`);
}

export async function createConnection(
	context: IRestApiContext,
	dto: CreateSecretsProviderConnectionDto,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(context, 'POST', `${root}/connections`, dto);
}

export async function updateConnection(
	context: IRestApiContext,
	providerKey: string,
	dto: UpdateSecretsProviderConnectionDto,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(context, 'PATCH', `${root}/connections/${providerKey}`, dto);
}

export async function deleteConnection(
	context: IRestApiContext,
	providerKey: string,
): Promise<void> {
	return await makeRestApiRequest(context, 'DELETE', `${root}/connections/${providerKey}`);
}

export async function reloadConnection(
	context: IRestApiContext,
	providerKey: string,
): Promise<{ success: boolean }> {
	return await makeRestApiRequest(context, 'POST', `${root}/connections/${providerKey}/reload`);
}

export async function testConnection(
	context: IRestApiContext,
	providerKey: string,
): Promise<TestSecretProviderConnectionResponse> {
	return await makeRestApiRequest(context, 'POST', `${root}/connections/${providerKey}/test`);
}

// #endregion

// #region Project-scoped connections

export async function getProjectConnections(
	context: IRestApiContext,
	projectId: string,
): Promise<SecretProviderConnectionListItem[]> {
	return await makeRestApiRequest(context, 'GET', `${root}/projects/${projectId}/connections`);
}

export async function getProjectConnection(
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(
		context,
		'GET',
		`${root}/projects/${projectId}/connections/${providerKey}`,
	);
}

export async function createProjectConnection(
	context: IRestApiContext,
	projectId: string,
	dto: CreateSecretsProviderConnectionDto,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(
		context,
		'POST',
		`${root}/projects/${projectId}/connections`,
		dto,
	);
}

export async function updateProjectConnection(
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
	dto: UpdateSecretsProviderConnectionDto,
): Promise<SecretProviderConnection> {
	return await makeRestApiRequest(
		context,
		'PATCH',
		`${root}/projects/${projectId}/connections/${providerKey}`,
		dto,
	);
}

export async function deleteProjectConnection(
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<void> {
	return await makeRestApiRequest(
		context,
		'DELETE',
		`${root}/projects/${projectId}/connections/${providerKey}`,
	);
}

export async function testProjectConnection(
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<TestSecretProviderConnectionResponse> {
	return await makeRestApiRequest(
		context,
		'POST',
		`${root}/projects/${projectId}/connections/${providerKey}/test`,
	);
}

// #endregion
