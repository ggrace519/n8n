<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { I18nT } from 'vue-i18n';
import { useToast } from '@n8n/composables/useToast';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useUIStore } from '@/app/stores/ui.store';
import { EXTERNAL_SECRETS_PROVIDER_MODAL_KEY } from '@/app/constants';
import {
	N8nActionToggle,
	N8nCard,
	N8nEmptyState,
	N8nHeading,
	N8nLink,
	N8nSwitch,
	N8nText,
} from '@n8n/design-system';

import { useExternalSecretsStore } from '../externalSecrets.store';
import type { ExternalSecretsProvider } from '../externalSecrets.types';

type ProviderAction = 'setup' | 'reload';

/** Shape N8nActionToggle needs for each menu item (the component isn't generic-exported). */
interface CardAction {
	label: string;
	value: ProviderAction;
}

const i18n = useI18n();
const toast = useToast();
const documentTitle = useDocumentTitle();
const uiStore = useUIStore();
const externalSecretsStore = useExternalSecretsStore();
const pageRedirectionHelper = usePageRedirectionHelper();

const loading = ref(false);

const isEnabled = computed(() => externalSecretsStore.isEnterpriseExternalSecretsEnabled);
const providers = computed(() => externalSecretsStore.providers);

const providerActions = computed<CardAction[]>(() => [
	{ value: 'setup', label: i18n.baseText('settings.externalSecrets.card.actionDropdown.setup') },
	{ value: 'reload', label: i18n.baseText('settings.externalSecrets.card.actionDropdown.reload') },
]);

function secretsCount(provider: ExternalSecretsProvider): number {
	return externalSecretsStore.state.secrets[provider.name]?.length ?? 0;
}

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('external-secrets', 'upgrade-external-secrets');
}

function openProviderModal(name: string) {
	uiStore.openModalWithData({
		name: EXTERNAL_SECRETS_PROVIDER_MODAL_KEY,
		data: { name },
	});
}

function onProviderAction(name: string, action: string) {
	if (action === 'setup') {
		openProviderModal(name);
	} else {
		void reloadProvider(name);
	}
}

async function reloadProvider(name: string) {
	try {
		const updated = await externalSecretsStore.reloadProvider(name);
		if (updated) {
			toast.showMessage({
				title: i18n.baseText('settings.externalSecrets.card.reload.success.title'),
				message: i18n.baseText('settings.externalSecrets.card.reload.success.description', {
					interpolate: { provider: name },
				}),
				type: 'success',
			});
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.card.reload.success.title'));
	}
}

async function onToggleConnected(provider: ExternalSecretsProvider, connected: boolean) {
	try {
		await externalSecretsStore.connectProvider(provider.name, connected);
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

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.externalSecrets.title'));
	if (!isEnabled.value) return;
	loading.value = true;
	try {
		await Promise.all([
			externalSecretsStore.fetchAllProviders(),
			externalSecretsStore.fetchAllSecrets(),
		]);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.title'));
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<div class="pb-3xl">
		<N8nHeading size="2xlarge" tag="h1">
			{{ i18n.baseText('settings.externalSecrets.title') }}
		</N8nHeading>

		<N8nText tag="p" :class="$style.description">
			<I18nT keypath="settings.externalSecrets.info" tag="span" scope="global">
				<template #link>
					<N8nLink :to="i18n.baseText('settings.externalSecrets.docs')" :new-window="true">
						{{ i18n.baseText('settings.externalSecrets.info.link') }}
					</N8nLink>
				</template>
			</I18nT>
		</N8nText>

		<N8nEmptyState
			v-if="!isEnabled"
			:description="i18n.baseText('settings.externalSecrets.actionBox.description')"
			:button-text="i18n.baseText('settings.externalSecrets.actionBox.buttonText')"
			data-test-id="external-secrets-content-unlicensed"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.externalSecrets.actionBox.title') }}</span>
			</template>
		</N8nEmptyState>

		<div v-else :class="$style.content" data-test-id="external-secrets-content-licensed">
			<N8nCard
				v-for="provider in providers"
				:key="provider.name"
				:class="$style.card"
				data-test-id="external-secrets-provider-card"
			>
				<div :class="$style.cardBody">
					<div :class="$style.cardInfo">
						<N8nText bold>{{ provider.displayName }}</N8nText>
						<N8nText size="small" color="text-light">
							{{
								provider.connected
									? i18n.baseText('settings.externalSecrets.card.connected')
									: i18n.baseText('settings.externalSecrets.card.disconnected')
							}}
						</N8nText>
						<N8nText size="small" color="text-light">
							{{
								i18n.baseText('settings.externalSecrets.card.secretsCount', {
									adjustToNumber: secretsCount(provider),
									interpolate: { count: secretsCount(provider) },
								})
							}}
						</N8nText>
					</div>
					<div :class="$style.cardActions">
						<N8nSwitch
							:model-value="provider.connected"
							:label="
								i18n.baseText('settings.externalSecrets.card.connectedSwitch.title', {
									interpolate: { provider: provider.displayName },
								})
							"
							data-test-id="external-secrets-provider-connected-switch"
							@update:model-value="(value: boolean) => onToggleConnected(provider, value)"
						/>
						<N8nActionToggle
							:actions="providerActions"
							data-test-id="external-secrets-provider-action-toggle"
							@action="(action: string) => onProviderAction(provider.name, action)"
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
	color: var(--color--text--tint-1);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
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

.cardActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}
</style>
