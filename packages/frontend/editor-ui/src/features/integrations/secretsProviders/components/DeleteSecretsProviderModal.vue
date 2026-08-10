<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { createEventBus } from '@n8n/utils/event-bus';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { DELETE_SECRETS_PROVIDER_MODAL_KEY } from '@/app/constants';
import { N8nButton, N8nInput, N8nInputLabel, N8nNotice, N8nText } from '@n8n/design-system';

import { useSecretsProviderConnection } from '../composables/useSecretsProviderConnection';

const props = defineProps<{
	modalName: string;
	data: {
		providerKey: string;
		name: string;
		secretsInUse?: number;
		projectId?: string;
		onDeleted?: () => Promise<void> | void;
		onClose?: () => void;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const uiStore = useUIStore();
const connection = useSecretsProviderConnection(props.data.projectId);

const modalBus = createEventBus();
const confirmText = ref('');
const isDeleting = ref(false);

const secretsInUse = computed(() => props.data.secretsInUse ?? 0);
const hasImpact = computed(() => secretsInUse.value > 0);
const canDelete = computed(() => confirmText.value === props.data.name && !isDeleting.value);

const title = computed(() =>
	i18n.baseText('settings.secretsProviderConnections.delete.title', {
		interpolate: { name: props.data.name },
	}),
);

const description = computed(() =>
	hasImpact.value
		? i18n.baseText('settings.secretsProviderConnections.delete.description', {
				interpolate: { secretsCount: secretsInUse.value },
			})
		: i18n.baseText('settings.secretsProviderConnections.delete.description.noImpact'),
);

function closeModal() {
	props.data.onClose?.();
	uiStore.closeModal(DELETE_SECRETS_PROVIDER_MODAL_KEY);
}

async function onDelete() {
	if (!canDelete.value) return;
	isDeleting.value = true;
	try {
		await connection.deleteConnection(props.data.providerKey);
		toast.showMessage({
			title: i18n.baseText('settings.secretsProviderConnections.delete.success', {
				interpolate: { name: props.data.name },
			}),
			type: 'success',
		});
		await props.data.onDeleted?.();
		uiStore.closeModal(DELETE_SECRETS_PROVIDER_MODAL_KEY);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.secretsProviderConnections.delete.error'));
	} finally {
		isDeleting.value = false;
	}
}
</script>

<template>
	<Modal
		:name="modalName"
		:event-bus="modalBus"
		:title="title"
		:center="true"
		width="480px"
		data-test-id="delete-secrets-provider-modal"
	>
		<template #content>
			<div :class="$style.content">
				<N8nText>{{ description }}</N8nText>

				<N8nNotice v-if="hasImpact" theme="warning">
					<div :class="$style.impact">
						<N8nText bold size="small">
							{{ i18n.baseText('settings.secretsProviderConnections.delete.impact.title') }}
						</N8nText>
						<N8nText size="small">
							{{
								secretsInUse === 1
									? i18n.baseText('settings.secretsProviderConnections.delete.impact.oneCredential')
									: i18n.baseText('settings.secretsProviderConnections.delete.impact.credentials', {
											interpolate: { count: secretsInUse },
										})
							}}
							{{ i18n.baseText('settings.secretsProviderConnections.delete.impact.description') }}
						</N8nText>
					</div>
				</N8nNotice>

				<N8nInputLabel
					:label="
						i18n.baseText('settings.secretsProviderConnections.delete.confirmationLabel', {
							interpolate: { name: data.name },
						})
					"
					:bold="false"
				>
					<N8nInput v-model="confirmText" data-test-id="delete-secrets-provider-confirm-input" />
				</N8nInputLabel>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="subtle"
					data-test-id="delete-secrets-provider-cancel-button"
					@click="closeModal"
				>
					{{ i18n.baseText('generic.cancel') }}
				</N8nButton>
				<N8nButton
					variant="destructive"
					:loading="isDeleting"
					:disabled="!canDelete"
					data-test-id="delete-secrets-provider-confirm-button"
					@click="onDelete"
				>
					{{ i18n.baseText('generic.delete') }}
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

.impact {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
