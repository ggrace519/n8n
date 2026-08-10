<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { useUIStore } from '@/app/stores/ui.store';
import {
	DELETE_SECRETS_PROVIDER_MODAL_KEY,
	SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
} from '@/app/constants';
import {
	N8nActionToggle,
	N8nBadge,
	N8nButton,
	N8nCard,
	N8nEmptyState,
	N8nHeading,
	N8nText,
	N8nTooltip,
} from '@n8n/design-system';
import type { SecretProviderConnection } from '@n8n/api-types';

import { useSecretsProvidersList } from '../composables/useSecretsProvidersList';

type ConnectionAction = 'edit' | 'share' | 'delete';

/** Shape N8nActionToggle needs for each menu item (the component isn't generic-exported). */
interface CardAction {
	label: string;
	value: ConnectionAction;
}

const i18n = useI18n();
const toast = useToast();
const documentTitle = useDocumentTitle();
const uiStore = useUIStore();
const secretsProviders = useSecretsProvidersList();

const loading = ref(false);

const connections = computed(() => secretsProviders.activeProviders.value);
const providerTypes = computed(() => secretsProviders.providerTypes.value);

const connectionActions = computed<CardAction[]>(() => [
	{ value: 'edit', label: i18n.baseText('settings.externalSecrets.card.actionDropdown.setup') },
	{ value: 'share', label: i18n.baseText('settings.secretsProviderConnections.actions.share') },
	{
		value: 'delete',
		label: i18n.baseText('settings.secretsProviderConnections.delete.impact.title'),
	},
]);

function displayNameForType(type: string): string {
	return (
		providerTypes.value.find((providerType) => providerType.type === type)?.displayName ?? type
	);
}

function isGlobal(connection: SecretProviderConnection): boolean {
	return connection.projects.length === 0;
}

function scopeTooltip(connection: SecretProviderConnection): string {
	return isGlobal(connection)
		? i18n.baseText('settings.secretsProviderConnections.badge.tooltip.global')
		: i18n.baseText('settings.secretsProviderConnections.badge.tooltip.project', {
				interpolate: { projectName: connection.projects.map((p) => p.name).join(', ') },
			});
}

function formatCreatedAt(createdAt: string): string {
	return i18n.baseText('settings.secretsProviderConnections.card.createdAt', {
		interpolate: { date: new Date(createdAt).toLocaleDateString() },
	});
}

async function refresh() {
	loading.value = true;
	try {
		await Promise.all([
			secretsProviders.fetchActiveConnections(),
			secretsProviders.fetchProviderTypes(),
		]);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.secretsProviderConnections.title'));
	} finally {
		loading.value = false;
	}
}

function openConnectionModal(providerKey?: string) {
	uiStore.openModalWithData({
		name: SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
		data: {
			activeTab: 'connection',
			providerKey,
			providerTypes: providerTypes.value,
			existingProviderNames: connections.value.map((connection) => connection.name),
			onClose: refresh,
		},
	});
}

function openDeleteModal(connection: SecretProviderConnection) {
	uiStore.openModalWithData({
		name: DELETE_SECRETS_PROVIDER_MODAL_KEY,
		data: {
			providerKey: connection.name,
			name: connection.name,
			secretsInUse: connection.secretsCount,
			onDeleted: refresh,
		},
	});
}

function onConnectionAction(connection: SecretProviderConnection, action: string) {
	if (action === 'delete') {
		openDeleteModal(connection);
	} else {
		openConnectionModal(connection.name);
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.secretsProviderConnections.title'));
	await refresh();
});
</script>

<template>
	<div class="pb-3xl">
		<N8nHeading size="2xlarge" tag="h1">
			{{ i18n.baseText('settings.secretsProviderConnections.title') }}
		</N8nHeading>

		<N8nText tag="p" :class="$style.description" color="text-light">
			{{ i18n.baseText('settings.secretsProviderConnections.description') }}
		</N8nText>

		<N8nEmptyState
			v-if="!loading && connections.length === 0"
			:description="i18n.baseText('settings.secretsProviderConnections.emptyState.description')"
			:button-text="i18n.baseText('settings.secretsProviderConnections.buttons.addSecretsStore')"
			data-test-id="secrets-providers-empty-state"
			@click:button="openConnectionModal()"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.secretsProviderConnections.emptyState.heading') }}</span>
			</template>
		</N8nEmptyState>

		<div v-else :class="$style.content" data-test-id="secrets-providers-content">
			<div :class="$style.actions">
				<N8nButton
					variant="outline"
					data-test-id="secrets-providers-add-button"
					@click="openConnectionModal()"
				>
					{{ i18n.baseText('settings.secretsProviderConnections.buttons.addSecretsStore') }}
				</N8nButton>
			</div>

			<N8nCard
				v-for="connection in connections"
				:key="connection.id"
				:class="$style.card"
				data-test-id="secrets-provider-connection-card"
			>
				<div :class="$style.cardBody">
					<div :class="$style.cardInfo">
						<div :class="$style.cardTitle">
							<N8nText bold>{{ connection.name }}</N8nText>
							<N8nTooltip :content="scopeTooltip(connection)">
								<N8nBadge theme="tertiary">
									{{
										isGlobal(connection)
											? i18n.baseText('settings.secretsProviderConnections.modal.scope.global')
											: i18n.baseText('settings.secretsProviderConnections.modal.items.scope')
									}}
								</N8nBadge>
							</N8nTooltip>
						</div>
						<N8nText size="small" color="text-light">
							{{ displayNameForType(connection.type) }}
						</N8nText>
						<N8nText size="small" color="text-light">
							{{ formatCreatedAt(connection.createdAt) }}
						</N8nText>
					</div>
					<div :class="$style.cardActions">
						<N8nText size="small" color="text-light">
							{{
								connection.isEnabled
									? i18n.baseText('settings.externalSecrets.card.connected')
									: i18n.baseText('settings.secretsProviderConnections.state.disabled')
							}}
						</N8nText>
						<N8nActionToggle
							:actions="connectionActions"
							data-test-id="secrets-provider-connection-action-toggle"
							@action="(action: string) => onConnectionAction(connection, action)"
						/>
					</div>
				</div>
			</N8nCard>
		</div>
	</div>
</template>

<style lang="scss" module>
.description {
	display: block;
	margin: var(--spacing--2xs) 0 var(--spacing--lg);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.actions {
	display: flex;
	justify-content: flex-end;
}

.card {
	width: 100%;
}

.cardBody {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--md);
}

.cardInfo {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.cardTitle {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.cardActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}
</style>
