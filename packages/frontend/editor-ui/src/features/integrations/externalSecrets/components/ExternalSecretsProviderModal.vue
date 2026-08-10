<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { createEventBus } from '@n8n/utils/event-bus';
import type { IDataObject, INodeProperties, NodeParameterValue } from 'n8n-workflow';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { EXTERNAL_SECRETS_PROVIDER_MODAL_KEY } from '@/app/constants';
import { N8nButton, N8nInput, N8nInputLabel, N8nSwitch, N8nText } from '@n8n/design-system';

import { useExternalSecretsStore } from '../externalSecrets.store';
import type { ExternalSecretsProvider } from '../externalSecrets.types';

const props = defineProps<{
	modalName: string;
	data: {
		name: string;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const uiStore = useUIStore();
const externalSecretsStore = useExternalSecretsStore();

const modalBus = createEventBus();

const provider = ref<ExternalSecretsProvider | null>(null);
const values = reactive<IDataObject>({});
const isLoading = ref(true);
const isSaving = ref(false);
const isTesting = ref(false);

const properties = computed<INodeProperties[]>(() => provider.value?.properties ?? []);
const isConnected = computed(() => provider.value?.connected ?? false);

function isPassword(property: INodeProperties): boolean {
	return Boolean(property.typeOptions?.password);
}

function stringValue(name: string): string {
	const value = values[name];
	return typeof value === 'string' ? value : '';
}

function setValue(name: string, value: NodeParameterValue) {
	values[name] = value;
}

async function loadProvider() {
	isLoading.value = true;
	try {
		const loaded = await externalSecretsStore.getProvider(props.data.name);
		provider.value = loaded;
		for (const property of loaded.properties ?? []) {
			values[property.name] = (loaded.data?.[property.name] ??
				property.default ??
				'') as NodeParameterValue;
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.title'));
	} finally {
		isLoading.value = false;
	}
}

async function onTest() {
	if (!provider.value) return;
	isTesting.value = true;
	try {
		const { success } = await externalSecretsStore.testProviderSettings(provider.value.name, {
			...values,
		});
		if (success) {
			toast.showMessage({
				title: i18n.baseText('settings.externalSecrets.provider.testConnection.success', {
					interpolate: { provider: provider.value.displayName },
				}),
				type: 'success',
			});
		} else {
			toast.showMessage({
				title: i18n.baseText('settings.externalSecrets.provider.testConnection.error', {
					interpolate: { provider: provider.value.displayName },
				}),
				type: 'error',
			});
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.provider.testConnection.error'));
	} finally {
		isTesting.value = false;
	}
}

async function onSave() {
	if (!provider.value) return;
	isSaving.value = true;
	try {
		await externalSecretsStore.updateProviderSettings(provider.value.name, { ...values });
		toast.showMessage({
			title: i18n.baseText('settings.externalSecrets.provider.save.success.title'),
			type: 'success',
		});
		closeModal();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.provider.save.success.title'));
	} finally {
		isSaving.value = false;
	}
}

async function onToggleConnected(connected: boolean) {
	if (!provider.value) return;
	try {
		await externalSecretsStore.connectProvider(provider.value.name, connected);
		provider.value = { ...provider.value, connected };
		toast.showMessage({
			title: connected
				? i18n.baseText('settings.externalSecrets.provider.connected.success.title')
				: i18n.baseText('settings.externalSecrets.provider.disconnected.success.title'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.provider.save.success.title'));
	}
}

function closeModal() {
	uiStore.closeModal(EXTERNAL_SECRETS_PROVIDER_MODAL_KEY);
}

onMounted(loadProvider);
</script>

<template>
	<Modal
		:name="modalName"
		:event-bus="modalBus"
		:title="provider?.displayName ?? props.data.name"
		:center="true"
		width="540px"
		data-test-id="external-secrets-provider-modal"
	>
		<template #content>
			<div v-if="!isLoading && provider" :class="$style.content">
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
						:data-test-id="`external-secrets-provider-field-${property.name}`"
						@update:model-value="(value: string) => setValue(property.name, value)"
					/>
					<N8nText v-if="property.description" size="small" color="text-light">
						{{ property.description }}
					</N8nText>
				</N8nInputLabel>

				<div :class="$style.connectRow">
					<N8nSwitch
						:model-value="isConnected"
						:label="
							i18n.baseText('settings.externalSecrets.card.connectedSwitch.title', {
								interpolate: { provider: provider.displayName },
							})
						"
						data-test-id="external-secrets-provider-modal-connected-switch"
						@update:model-value="onToggleConnected"
					/>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="subtle"
					data-test-id="external-secrets-provider-modal-cancel-button"
					@click="closeModal"
				>
					{{ i18n.baseText('settings.externalSecrets.provider.buttons.cancel') }}
				</N8nButton>
				<N8nButton
					variant="outline"
					:loading="isTesting"
					data-test-id="external-secrets-provider-modal-test-button"
					@click="onTest"
				>
					{{ i18n.baseText('settings.externalSecrets.provider.buttons.test') }}
				</N8nButton>
				<N8nButton
					variant="solid"
					:loading="isSaving"
					data-test-id="external-secrets-provider-modal-save-button"
					@click="onSave"
				>
					{{
						isSaving
							? i18n.baseText('settings.externalSecrets.provider.buttons.saving')
							: i18n.baseText('settings.externalSecrets.provider.buttons.save')
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

.connectRow {
	margin-top: var(--spacing--xs);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
