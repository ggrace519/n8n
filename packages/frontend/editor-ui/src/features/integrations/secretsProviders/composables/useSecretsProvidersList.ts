import { ref } from 'vue';
import { useRootStore } from '@n8n/stores/useRootStore';
import type { SecretProviderConnection, SecretProviderTypeResponse } from '@n8n/api-types';

import * as secretsProvidersApi from '../secretsProviders.api';

/**
 * The instance-wide connections. The list endpoint omits `settings`/`secrets`
 * (never sent in list views); we normalise each item to a full connection with
 * an empty settings object so consumers share one type.
 */
const activeProviders = ref<SecretProviderConnection[]>([]);
const providerTypes = ref<SecretProviderTypeResponse[]>([]);

/**
 * Access to the instance-wide secret-provider catalog and active connections.
 * Backing refs are module-level so every caller shares the same loaded data.
 */
export function useSecretsProvidersList() {
	const rootStore = useRootStore();

	async function fetchProviderTypes(): Promise<void> {
		providerTypes.value = await secretsProvidersApi.getProviderTypes(rootStore.restApiContext);
	}

	async function fetchActiveConnections(): Promise<void> {
		const connections = await secretsProvidersApi.getConnections(rootStore.restApiContext);
		activeProviders.value = connections.map((connection) => ({
			...connection,
			settings: {},
		}));
	}

	return {
		activeProviders,
		providerTypes,
		fetchProviderTypes,
		fetchActiveConnections,
	};
}
