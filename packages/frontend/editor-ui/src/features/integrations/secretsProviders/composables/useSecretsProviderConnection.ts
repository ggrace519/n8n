import { ref } from 'vue';
import { useRootStore } from '@n8n/stores/useRootStore';
import type {
	CreateSecretsProviderConnectionDto,
	SecretProviderConnection,
	SecretsProviderConnectionTestState,
	TestSecretProviderConnectionResponse,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';

import * as secretsProvidersApi from '../secretsProviders.api';

/**
 * Drives a single secret-provider connection's lifecycle (read / create /
 * update / delete / test). Pass a `projectId` to operate on a project's
 * connections; omit it for instance-wide administration. Each call owns its own
 * reactive state so independent forms don't clobber one another.
 */
export function useSecretsProviderConnection(projectId?: string) {
	const rootStore = useRootStore();

	const connectionState = ref<SecretsProviderConnectionTestState | 'idle'>('idle');
	const connectionError = ref<string | undefined>(undefined);
	const isLoading = ref(false);
	const isTesting = ref(false);

	async function getConnection(providerKey: string): Promise<SecretProviderConnection> {
		isLoading.value = true;
		try {
			return projectId
				? await secretsProvidersApi.getProjectConnection(
						rootStore.restApiContext,
						projectId,
						providerKey,
					)
				: await secretsProvidersApi.getConnection(rootStore.restApiContext, providerKey);
		} finally {
			isLoading.value = false;
		}
	}

	async function createConnection(
		dto: CreateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnection> {
		isLoading.value = true;
		try {
			return projectId
				? await secretsProvidersApi.createProjectConnection(
						rootStore.restApiContext,
						projectId,
						dto,
					)
				: await secretsProvidersApi.createConnection(rootStore.restApiContext, dto);
		} finally {
			isLoading.value = false;
		}
	}

	async function updateConnection(
		providerKey: string,
		dto: UpdateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnection> {
		isLoading.value = true;
		try {
			return projectId
				? await secretsProvidersApi.updateProjectConnection(
						rootStore.restApiContext,
						projectId,
						providerKey,
						dto,
					)
				: await secretsProvidersApi.updateConnection(rootStore.restApiContext, providerKey, dto);
		} finally {
			isLoading.value = false;
		}
	}

	async function deleteConnection(providerKey: string): Promise<void> {
		isLoading.value = true;
		try {
			if (projectId) {
				await secretsProvidersApi.deleteProjectConnection(
					rootStore.restApiContext,
					projectId,
					providerKey,
				);
			} else {
				await secretsProvidersApi.deleteConnection(rootStore.restApiContext, providerKey);
			}
		} finally {
			isLoading.value = false;
		}
	}

	async function testConnection(
		providerKey: string,
	): Promise<TestSecretProviderConnectionResponse> {
		isTesting.value = true;
		connectionError.value = undefined;
		try {
			const result = projectId
				? await secretsProvidersApi.testProjectConnection(
						rootStore.restApiContext,
						projectId,
						providerKey,
					)
				: await secretsProvidersApi.testConnection(rootStore.restApiContext, providerKey);
			connectionState.value = result.testState;
			connectionError.value = result.error;
			return result;
		} finally {
			isTesting.value = false;
		}
	}

	return {
		connectionState,
		connectionError,
		isLoading,
		isTesting,
		getConnection,
		createConnection,
		updateConnection,
		deleteConnection,
		testConnection,
	};
}
