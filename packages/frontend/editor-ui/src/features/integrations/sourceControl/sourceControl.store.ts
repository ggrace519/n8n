import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { EnterpriseEditionFeature } from '@/app/constants';
import * as sourceControlApi from './sourceControl.api';
import type {
	PullWorkfolderPayload,
	PushWorkfolderPayload,
	PushWorkfolderResult,
	SourceControlStatusOptions,
} from './sourceControl.api';
import { SOURCE_CONTROL_DEFAULT_BRANCH_COLOR } from './sourceControl.constants';
import type { SourceControlPreferences, SshKeyType } from './sourceControl.types';

const DEFAULT_PREFERENCES: SourceControlPreferences = {
	connected: false,
	repositoryUrl: '',
	branchName: '',
	branchReadOnly: false,
	branchColor: SOURCE_CONTROL_DEFAULT_BRANCH_COLOR,
	publicKey: '',
	keyGeneratorType: 'ed25519',
};

export const useSourceControlStore = defineStore('sourceControl', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	const preferences = reactive<SourceControlPreferences>({ ...DEFAULT_PREFERENCES });

	const isEnterpriseSourceControlEnabled = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.SourceControl],
	);

	/**
	 * Merge a partial preferences payload (e.g. an API response that redacts some
	 * fields, or a local form edit) into the reactive preferences object.
	 */
	function setPreferences(data: Partial<SourceControlPreferences>) {
		Object.assign(preferences, data);
	}

	async function getPreferences(): Promise<SourceControlPreferences> {
		const data = await sourceControlApi.getPreferences(rootStore.restApiContext);
		setPreferences(data);
		return data;
	}

	async function savePreferences(
		payload: Partial<SourceControlPreferences>,
	): Promise<SourceControlPreferences> {
		const data = await sourceControlApi.savePreferences(rootStore.restApiContext, payload);
		setPreferences(data);
		return data;
	}

	async function updatePreferences(
		payload: Partial<SourceControlPreferences>,
	): Promise<SourceControlPreferences> {
		const data = await sourceControlApi.updatePreferences(rootStore.restApiContext, payload);
		setPreferences(data);
		return data;
	}

	async function disconnect(keepKeyPair: boolean): Promise<void> {
		const data = await sourceControlApi.disconnect(rootStore.restApiContext, keepKeyPair);
		setPreferences({ ...data, connected: false });
	}

	async function getBranches(): Promise<{ branches: string[]; currentBranch: string }> {
		return await sourceControlApi.getBranches(rootStore.restApiContext);
	}

	async function generateKeyPair(
		keyGeneratorType?: SshKeyType,
	): Promise<{ publicKey: string; keyGeneratorType: SshKeyType }> {
		const data = await sourceControlApi.generateKeyPair(rootStore.restApiContext, keyGeneratorType);
		setPreferences({ publicKey: data.publicKey, keyGeneratorType: data.keyGeneratorType });
		return data;
	}

	async function getStatus() {
		return await sourceControlApi.getStatus(rootStore.restApiContext);
	}

	async function getAggregatedStatus(options: SourceControlStatusOptions) {
		return await sourceControlApi.getAggregatedStatus(rootStore.restApiContext, options);
	}

	async function pushWorkfolder(payload: PushWorkfolderPayload): Promise<PushWorkfolderResult> {
		return await sourceControlApi.pushWorkfolder(rootStore.restApiContext, payload);
	}

	async function pullWorkfolder(payload: PullWorkfolderPayload) {
		return await sourceControlApi.pullWorkfolder(rootStore.restApiContext, payload);
	}

	async function getRemoteWorkflow(id: string) {
		return await sourceControlApi.getRemoteWorkflow(rootStore.restApiContext, id);
	}

	/**
	 * Whether a project participates in source-control sharing. Resources are
	 * only synced across the repository once the instance is connected.
	 */
	function isProjectShared(_projectId: string): boolean {
		return preferences.connected;
	}

	return {
		preferences,
		isEnterpriseSourceControlEnabled,
		setPreferences,
		getPreferences,
		savePreferences,
		updatePreferences,
		disconnect,
		getBranches,
		generateKeyPair,
		getStatus,
		getAggregatedStatus,
		pushWorkfolder,
		pullWorkfolder,
		getRemoteWorkflow,
		isProjectShared,
	};
});
