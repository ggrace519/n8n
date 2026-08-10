<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { createEventBus } from '@n8n/utils/event-bus';
import type { IDataObject, INodeProperties, NodeParameterValue } from 'n8n-workflow';
import type { SecretProviderTypeResponse, SecretsProviderType } from '@n8n/api-types';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import { SECRETS_PROVIDER_CONNECTION_MODAL_KEY } from '@/app/constants';
import {
	N8nButton,
	N8nInput,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nTabs,
	N8nText,
} from '@n8n/design-system';

import { useSecretsProviderConnection } from '../composables/useSecretsProviderConnection';

/** Connection name: starts with a letter, then letters/digits only. Mirrors the backend DTO. */
const CONNECTION_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9]*$/;

const props = defineProps<{
	modalName: string;
	data: {
		activeTab?: 'connection' | 'sharing';
		providerKey?: string;
		providerTypes: SecretProviderTypeResponse[];
		existingProviderNames: string[];
		projectId?: string;
		onClose?: () => Promise<void> | void;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const uiStore = useUIStore();
const projectsStore = useProjectsStore();
const connection = useSecretsProviderConnection(props.data.projectId);

const modalBus = createEventBus();

const isEditing = computed(() => Boolean(props.data.providerKey));

const activeTab = ref<'connection' | 'scope'>(
	props.data.activeTab === 'sharing' ? 'scope' : 'connection',
);
const connectionName = ref('');
const providerType = ref<SecretsProviderType | ''>('');
const projectIds = ref<string[]>([]);
const settings = reactive<IDataObject>({});
const isSaving = ref(false);
const isDirty = ref(false);

const tabs = computed(() => [
	{
		value: 'connection',
		label: i18n.baseText('settings.secretsProviderConnections.modal.items.connection'),
	},
	{ value: 'scope', label: i18n.baseText('settings.secretsProviderConnections.modal.items.scope') },
]);

const selectedType = computed<SecretProviderTypeResponse | undefined>(() =>
	props.data.providerTypes.find((type) => type.type === providerType.value),
);

const properties = computed<INodeProperties[]>(() => selectedType.value?.properties ?? []);

const shareableProjects = computed(() =>
	projectsStore.availableProjects.filter((project) => project.type !== 'personal'),
);

const nameError = computed<string | null>(() => {
	if (isEditing.value) return null;
	const name = connectionName.value.trim();
	if (!name)
		return i18n.baseText(
			'settings.secretsProviderConnections.modal.validation.connectionName.required',
		);
	if (!CONNECTION_NAME_REGEX.test(name)) {
		return i18n.baseText(
			'settings.secretsProviderConnections.modal.validation.connectionName.format',
		);
	}
	if (props.data.existingProviderNames.includes(name)) {
		return i18n.baseText('settings.secretsProviderConnections.modal.connectionName.unique');
	}
	return null;
});

const canSave = computed(() => !nameError.value && Boolean(providerType.value) && !isSaving.value);

function isPassword(property: INodeProperties): boolean {
	return Boolean(property.typeOptions?.password);
}

function stringValue(name: string): string {
	const value = settings[name];
	return typeof value === 'string' ? value : '';
}

function setSetting(name: string, value: NodeParameterValue) {
	settings[name] = value;
	isDirty.value = true;
}

function seedSettings(properties: INodeProperties[], stored: IDataObject = {}) {
	for (const property of properties) {
		settings[property.name] = (stored[property.name] ??
			property.default ??
			'') as NodeParameterValue;
	}
}

function onProviderTypeChange(type: SecretsProviderType) {
	providerType.value = type;
	isDirty.value = true;
	for (const key of Object.keys(settings)) delete settings[key];
	seedSettings(selectedType.value?.properties ?? []);
}

async function loadConnection() {
	if (!props.data.providerKey) return;
	try {
		const existing = await connection.getConnection(props.data.providerKey);
		connectionName.value = existing.name;
		providerType.value = existing.type;
		projectIds.value = existing.projects.map((project) => project.id);
		seedSettings(selectedType.value?.properties ?? [], existing.settings);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.secretsProviderConnections.title'));
	}
}

async function onTest() {
	if (!props.data.providerKey) return;
	const result = await connection.testConnection(props.data.providerKey);
	if (result.success) {
		toast.showMessage({
			title: i18n.baseText(
				'settings.secretsProviderConnections.modal.testConnection.success.reference',
			),
			type: 'success',
		});
	} else {
		toast.showMessage({
			title: i18n.baseText('settings.secretsProviderConnections.modal.testConnection.error'),
			message: result.error,
			type: 'error',
		});
	}
}

async function onSave() {
	if (!canSave.value || !providerType.value) return;
	isSaving.value = true;
	try {
		if (props.data.providerKey) {
			await connection.updateConnection(props.data.providerKey, {
				type: providerType.value,
				projectIds: projectIds.value,
				settings: { ...settings },
			});
		} else {
			await connection.createConnection({
				providerKey: connectionName.value.trim(),
				type: providerType.value,
				projectIds: projectIds.value,
				settings: { ...settings },
			});
		}
		await props.data.onClose?.();
		uiStore.closeModal(SECRETS_PROVIDER_CONNECTION_MODAL_KEY);
	} catch (error) {
		toast.showError(
			error,
			i18n.baseText('settings.secretsProviderConnections.modal.testConnection.error'),
		);
	} finally {
		isSaving.value = false;
	}
}

function closeModal() {
	uiStore.closeModal(SECRETS_PROVIDER_CONNECTION_MODAL_KEY);
}

onMounted(loadConnection);
</script>

<template>
	<Modal
		:name="modalName"
		:event-bus="modalBus"
		:title="
			connectionName || i18n.baseText('settings.secretsProviderConnections.buttons.addSecretsStore')
		"
		:center="true"
		width="600px"
		data-test-id="secrets-provider-connection-modal"
	>
		<template #content>
			<div :class="$style.content">
				<N8nTabs
					v-model="activeTab"
					:options="tabs"
					data-test-id="secrets-provider-connection-tabs"
				/>

				<div v-show="activeTab === 'connection'" :class="$style.tab">
					<N8nInputLabel
						:label="i18n.baseText('settings.secretsProviderConnections.modal.connectionName')"
						:bold="false"
					>
						<N8nInput
							v-model="connectionName"
							:disabled="isEditing"
							:state="nameError ? 'error' : 'default'"
							data-test-id="secrets-provider-connection-name-input"
						/>
						<N8nText v-if="nameError" color="danger" size="small">{{ nameError }}</N8nText>
						<N8nText v-else color="text-light" size="small">
							{{ i18n.baseText('settings.secretsProviderConnections.modal.connectionName.hint') }}
						</N8nText>
					</N8nInputLabel>

					<N8nInputLabel
						:label="i18n.baseText('settings.secretsProviderConnections.modal.providerType')"
						:bold="false"
					>
						<N8nSelect
							:model-value="providerType"
							:placeholder="
								i18n.baseText('settings.secretsProviderConnections.modal.providerType.placeholder')
							"
							:teleported="false"
							data-test-id="secrets-provider-connection-type-select"
							@update:model-value="onProviderTypeChange"
						>
							<N8nOption
								v-for="type in data.providerTypes"
								:key="type.type"
								:value="type.type"
								:label="type.displayName"
							/>
						</N8nSelect>
					</N8nInputLabel>

					<N8nInputLabel
						v-for="property in properties"
						:key="property.name"
						:label="property.displayName"
						:bold="false"
					>
						<N8nInput
							:model-value="stringValue(property.name)"
							:type="isPassword(property) ? 'password' : 'text'"
							:placeholder="property.placeholder ?? ''"
							:data-test-id="`secrets-provider-connection-field-${property.name}`"
							@update:model-value="(value: string) => setSetting(property.name, value)"
						/>
						<N8nText v-if="property.description" color="text-light" size="small">
							{{ property.description }}
						</N8nText>
					</N8nInputLabel>
				</div>

				<div v-show="activeTab === 'scope'" :class="$style.tab">
					<N8nText color="text-light" size="small">
						{{ i18n.baseText('settings.secretsProviderConnections.modal.scope.info') }}
					</N8nText>
					<N8nInputLabel
						:label="i18n.baseText('settings.secretsProviderConnections.modal.scope.label')"
						:bold="false"
					>
						<N8nSelect
							v-model="projectIds"
							multiple
							filterable
							:placeholder="
								i18n.baseText('settings.secretsProviderConnections.modal.scope.placeholder.project')
							"
							:no-match-text="
								i18n.baseText('settings.secretsProviderConnections.modal.scope.emptyOptionsText')
							"
							:teleported="false"
							data-test-id="secrets-provider-connection-scope-select"
						>
							<N8nOption
								v-for="project in shareableProjects"
								:key="project.id"
								:value="project.id"
								:label="project.name ?? project.id"
							/>
						</N8nSelect>
						<N8nText color="text-light" size="small">
							{{
								projectIds.length === 0
									? i18n.baseText('settings.secretsProviderConnections.modal.scope.global')
									: ''
							}}
						</N8nText>
					</N8nInputLabel>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="subtle"
					data-test-id="secrets-provider-connection-cancel-button"
					@click="closeModal"
				>
					{{ i18n.baseText('generic.cancel') }}
				</N8nButton>
				<N8nButton
					v-if="isEditing"
					variant="outline"
					:loading="connection.isTesting.value"
					data-test-id="secrets-provider-connection-test-button"
					@click="onTest"
				>
					{{ i18n.baseText('settings.externalSecrets.provider.buttons.test') }}
				</N8nButton>
				<N8nButton
					variant="solid"
					:loading="isSaving"
					:disabled="!canSave"
					data-test-id="secrets-provider-connection-save-button"
					@click="onSave"
				>
					{{
						isSaving
							? i18n.baseText('settings.secretsProviderConnections.modal.saving')
							: i18n.baseText('generic.save')
					}}
				</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.tab {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
