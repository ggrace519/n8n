<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import type { BaseTextKey } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useUIStore } from '@/app/stores/ui.store';
import { LOG_STREAM_MODAL_KEY } from '@/app/constants';
import {
	N8nButton,
	N8nCard,
	N8nEmptyState,
	N8nHeading,
	N8nIcon,
	N8nNotice,
	N8nText,
} from '@n8n/design-system';
import {
	defaultMessageEventBusDestinationSentryOptions,
	defaultMessageEventBusDestinationSyslogOptions,
	defaultMessageEventBusDestinationWebhookOptions,
	deepCopy,
	MessageEventBusDestinationTypeNames,
} from 'n8n-workflow';

import { useLogStreamingStore } from '@/features/integrations/logStreaming/logStreaming.store';
import { DESTINATION_TYPES } from '@/features/integrations/logStreaming/logStreaming.constants';
import type {
	MessageEventBusDestinationOptions,
	MessageEventBusDestinationType,
} from '@/features/integrations/logStreaming/logStreaming.types';

const i18n = useI18n();
const toast = useToast();
const documentTitle = useDocumentTitle();
const pageRedirectionHelper = usePageRedirectionHelper();
const uiStore = useUIStore();
const logStreamingStore = useLogStreamingStore();

const loading = ref(false);

const isEnabled = computed(() => logStreamingStore.isEnterpriseLogStreamingEnabled);
const isManagedByEnv = computed(() => logStreamingStore.isManagedByEnv);
const destinations = computed(() => logStreamingStore.destinations);
const hasDestinations = computed(() => logStreamingStore.hasDestinations);

const defaultsByType: Record<MessageEventBusDestinationType, MessageEventBusDestinationOptions> = {
	[MessageEventBusDestinationTypeNames.webhook]: defaultMessageEventBusDestinationWebhookOptions,
	[MessageEventBusDestinationTypeNames.sentry]: defaultMessageEventBusDestinationSentryOptions,
	[MessageEventBusDestinationTypeNames.syslog]: defaultMessageEventBusDestinationSyslogOptions,
};

function typeLabel(destination: MessageEventBusDestinationOptions): string {
	const key = `settings.log-streaming.${destination.__type ?? ''}`;
	const label = i18n.baseText(key as BaseTextKey);
	return label === key ? (destination.__type ?? '') : label;
}

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('log-streaming', 'upgrade-log-streaming');
}

function openDestination(destination: MessageEventBusDestinationOptions, isNew: boolean) {
	uiStore.openModalWithData({
		name: LOG_STREAM_MODAL_KEY,
		data: { destination: deepCopy(destination), isNew },
	});
}

function addDestination(type: MessageEventBusDestinationType) {
	openDestination(defaultsByType[type], true);
}

async function loadDestinations() {
	loading.value = true;
	try {
		await logStreamingStore.fetchDestinations();
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	} finally {
		loading.value = false;
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.log-streaming.heading'));
	if (!isEnabled.value) return;
	await loadDestinations();
});
</script>

<template>
	<div :class="$style.container" data-test-id="log-streaming-settings">
		<N8nHeading tag="h1" size="2xlarge">
			{{ i18n.baseText('settings.log-streaming.heading') }}
		</N8nHeading>

		<N8nEmptyState
			v-if="!isEnabled"
			:description="i18n.baseText('settings.log-streaming.actionBox.description')"
			:button-text="i18n.baseText('settings.log-streaming.actionBox.button')"
			data-test-id="log-streaming-content-unlicensed"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.log-streaming.actionBox.title') }}</span>
			</template>
		</N8nEmptyState>

		<div v-else :class="$style.content" data-test-id="log-streaming-content-licensed">
			<N8nText :class="$style.info" tag="div" size="medium" color="text-base">
				<span v-n8n-html="i18n.baseText('settings.log-streaming.infoText')" />
			</N8nText>

			<N8nNotice v-if="isManagedByEnv" theme="warning" data-test-id="log-streaming-managed-by-env">
				{{ i18n.baseText('settings.log-streaming.managedByEnv') }}
			</N8nNotice>

			<div v-if="!hasDestinations" :class="$style.emptyBox" data-test-id="log-streaming-empty">
				<N8nHeading tag="h2" size="large">
					{{ i18n.baseText('settings.log-streaming.addFirstTitle') }}
				</N8nHeading>
				<N8nText color="text-base">
					{{ i18n.baseText('settings.log-streaming.addFirst') }}
				</N8nText>
				<div :class="$style.addButtons">
					<N8nButton
						v-for="type in DESTINATION_TYPES"
						:key="type"
						variant="outline"
						:disabled="isManagedByEnv"
						:label="i18n.baseText(`settings.log-streaming.${type}` as BaseTextKey)"
						:data-test-id="`log-streaming-add-${type}`"
						@click="addDestination(type)"
					/>
				</div>
			</div>

			<div v-else :class="$style.destinations">
				<div :class="$style.destinationsHeader">
					<N8nHeading tag="h2" size="large">
						{{ i18n.baseText('settings.log-streaming.destinations') }}
					</N8nHeading>
					<div :class="$style.addButtons">
						<N8nButton
							v-for="type in DESTINATION_TYPES"
							:key="type"
							variant="outline"
							:disabled="isManagedByEnv"
							:label="i18n.baseText(`settings.log-streaming.${type}` as BaseTextKey)"
							:data-test-id="`log-streaming-add-${type}`"
							@click="addDestination(type)"
						/>
					</div>
				</div>

				<N8nCard
					v-for="destination in destinations"
					:key="destination.id"
					:class="$style.card"
					:data-test-id="`log-streaming-destination-${destination.id}`"
					@click="openDestination(destination, false)"
				>
					<div :class="$style.cardBody">
						<div :class="$style.cardInfo">
							<N8nText bold>{{ destination.label }}</N8nText>
							<N8nText size="small" color="text-light">{{ typeLabel(destination) }}</N8nText>
						</div>
						<N8nText
							size="small"
							:color="destination.enabled ? 'success' : 'text-light'"
							:class="$style.cardStatus"
						>
							<N8nIcon :icon="destination.enabled ? 'circle-check' : 'circle-x'" size="small" />
						</N8nText>
					</div>
				</N8nCard>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--l);
	padding-bottom: var(--spacing--2xl);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--m);
}

.info {
	line-height: var(--line-height--xl);
}

.emptyBox {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--spacing--s);
	padding: var(--spacing--l);
	border: var(--border);
	border-radius: var(--radius--md);
	background-color: var(--background--surface);
}

.destinations {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.destinationsHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--s);
	margin-bottom: var(--spacing--xs);
}

.addButtons {
	display: flex;
	gap: var(--spacing--xs);
	flex-wrap: wrap;
}

.card {
	cursor: pointer;
}

.cardBody {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--s);
	width: 100%;
}

.cardInfo {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.cardStatus {
	display: flex;
	align-items: center;
}
</style>
