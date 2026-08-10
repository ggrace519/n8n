import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type { IDataObject } from 'n8n-workflow';

import { EnterpriseEditionFeature } from '@/app/constants';
import * as externalSecretsApi from './externalSecrets.api';
import type { ExternalSecretsProvider } from './externalSecrets.types';

/** Provider -> list of secret names, as returned by the completions endpoints. */
type SecretNamesByProvider = Record<string, string[]>;

/**
 * Provider -> `{ secretName: placeholder }`. The frontend only ever learns
 * secret names (values stay confined to credential evaluation), so each name
 * maps to itself; the shape is what expression resolution and completions
 * expect for `$secrets`.
 */
type SecretsObject = Record<string, Record<string, string>>;

interface ExternalSecretsState {
	/** Instance-wide secret names (legacy single-connection view of `$secrets`). */
	secrets: SecretNamesByProvider;
	/** Global connections' secret names, scoped to the current project context. */
	globalSecrets: SecretNamesByProvider;
	/** Current project's own connections' secret names. */
	projectSecrets: SecretNamesByProvider;
	/** Legacy provider summaries backing the single-connection settings view. */
	providers: ExternalSecretsProvider[];
}

function toSecretsObject(secrets: SecretNamesByProvider): SecretsObject {
	return Object.fromEntries(
		Object.entries(secrets).map(([provider, names]) => [
			provider,
			Object.fromEntries(names.map((name) => [name, name])),
		]),
	);
}

export const useExternalSecretsStore = defineStore('externalSecrets', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	const state = reactive<ExternalSecretsState>({
		secrets: {},
		globalSecrets: {},
		projectSecrets: {},
		providers: [],
	});

	const isEnterpriseExternalSecretsEnabled = computed<boolean>(
		() =>
			settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.ExternalSecrets] ?? false,
	);

	const secretsAsObject = computed<SecretsObject>(() => toSecretsObject(state.secrets));
	const globalSecretsAsObject = computed<SecretsObject>(() => toSecretsObject(state.globalSecrets));
	const projectSecretsAsObject = computed<SecretsObject>(() =>
		toSecretsObject(state.projectSecrets),
	);

	const providers = computed<ExternalSecretsProvider[]>(() => state.providers);

	/**
	 * Load the secret names available to a project: global connections plus the
	 * project's own. Populates the `$secrets` completion sources.
	 */
	async function fetchSecretsForProject(projectId: string): Promise<void> {
		const [globalSecrets, projectSecrets] = await Promise.all([
			externalSecretsApi.getGlobalSecretsForProject(rootStore.restApiContext, projectId),
			externalSecretsApi.getProjectSecrets(rootStore.restApiContext, projectId),
		]);
		state.globalSecrets = globalSecrets;
		state.projectSecrets = projectSecrets;
	}

	async function fetchAllSecrets(): Promise<SecretNamesByProvider> {
		const secrets = await externalSecretsApi.getExternalSecretNames(rootStore.restApiContext);
		state.secrets = secrets;
		return secrets;
	}

	async function fetchAllProviders(): Promise<ExternalSecretsProvider[]> {
		const result = await externalSecretsApi.getExternalSecretsProviders(rootStore.restApiContext);
		state.providers = result;
		return result;
	}

	async function getProvider(name: string): Promise<ExternalSecretsProvider> {
		return await externalSecretsApi.getExternalSecretsProvider(rootStore.restApiContext, name);
	}

	async function testProviderSettings(
		name: string,
		data: IDataObject,
	): Promise<{ success: boolean; testState: 'connected' | 'error' }> {
		return await externalSecretsApi.testExternalSecretsProviderSettings(
			rootStore.restApiContext,
			name,
			data,
		);
	}

	async function updateProviderSettings(name: string, data: IDataObject): Promise<void> {
		await externalSecretsApi.setExternalSecretsProviderSettings(
			rootStore.restApiContext,
			name,
			data,
		);
		await fetchAllProviders();
	}

	async function connectProvider(name: string, connected: boolean): Promise<void> {
		await externalSecretsApi.setExternalSecretsProviderConnected(
			rootStore.restApiContext,
			name,
			connected,
		);
		await Promise.all([fetchAllProviders(), fetchAllSecrets()]);
	}

	async function reloadProvider(name: string): Promise<boolean> {
		const { updated } = await externalSecretsApi.reloadExternalSecretsProvider(
			rootStore.restApiContext,
			name,
		);
		if (updated) await fetchAllSecrets();
		return updated;
	}

	return {
		state,
		isEnterpriseExternalSecretsEnabled,
		secretsAsObject,
		globalSecretsAsObject,
		projectSecretsAsObject,
		providers,
		fetchSecretsForProject,
		fetchAllSecrets,
		fetchAllProviders,
		getProvider,
		testProviderSettings,
		updateProviderSettings,
		connectProvider,
		reloadProvider,
	};
});
