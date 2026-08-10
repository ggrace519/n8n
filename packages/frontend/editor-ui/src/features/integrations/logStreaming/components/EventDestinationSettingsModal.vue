<script lang="ts" setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import type { BaseTextKey } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import type { EventBus } from '@n8n/utils/event-bus';
import {
	MessageEventBusDestinationTypeNames,
	defaultMessageEventBusDestinationSentryOptions,
	defaultMessageEventBusDestinationSyslogOptions,
	defaultMessageEventBusDestinationWebhookOptions,
	deepCopy,
} from 'n8n-workflow';
import {
	N8nButton,
	N8nCheckbox,
	N8nHeading,
	N8nIcon,
	N8nInput,
	N8nInputLabel,
	N8nInputNumber,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nSwitch,
	N8nTabs,
	N8nText,
	useMessage,
} from '@n8n/design-system';
import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useLogStreamingStore } from '@/features/integrations/logStreaming/logStreaming.store';
import { EVENT_GROUPS } from '@/features/integrations/logStreaming/logStreaming.constants';
import type { MessageEventBusDestinationOptions } from '@/features/integrations/logStreaming/logStreaming.types';

/** Working copy of a destination that may hold any concrete type's fields. */
type DestinationForm = MessageEventBusDestinationOptions & {
	url?: string;
	method?: string;
	dsn?: string;
	host?: string;
	port?: number;
	protocol?: string;
};

const props = defineProps<{
	modalName: string;
	destination: MessageEventBusDestinationOptions;
	isNew: boolean;
	eventBus?: EventBus;
}>();

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const uiStore = useUIStore();
const logStreamingStore = useLogStreamingStore();

const working = reactive<DestinationForm>({ ...deepCopy(props.destination) });
if (!Array.isArray(working.subscribedEvents)) working.subscribedEvents = [];

const activeTab = ref('settings');
const expandedGroups = ref<Set<string>>(new Set());
const saving = ref(false);
const deleting = ref(false);

const isManagedByEnv = computed(() => logStreamingStore.isManagedByEnv);

const isWebhook = computed(() => working.__type === MessageEventBusDestinationTypeNames.webhook);
const isSentry = computed(() => working.__type === MessageEventBusDestinationTypeNames.sentry);
const isSyslog = computed(() => working.__type === MessageEventBusDestinationTypeNames.syslog);

const tabOptions = computed(() => [
	{ value: 'settings', label: i18n.baseText('settings.log-streaming.tab.settings') },
	{ value: 'events', label: i18n.baseText('settings.log-streaming.tab.events') },
]);

const typeLabel = computed(() => {
	const key = `settings.log-streaming.${working.__type ?? ''}`;
	const label = i18n.baseText(key as BaseTextKey);
	return label === key ? (working.__type ?? '') : label;
});

const methodOptions = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const protocolOptions = ['udp', 'tcp', 'tls'];

const canSave = computed(() => {
	if (isManagedByEnv.value || saving.value) return false;
	if (!working.label) return false;
	if (isWebhook.value) return !!working.url;
	if (isSentry.value) return !!working.dsn;
	if (isSyslog.value) return !!working.host;
	return false;
});

const defaultsByType: Record<string, DestinationForm> = {
	[MessageEventBusDestinationTypeNames.webhook]: defaultMessageEventBusDestinationWebhookOptions,
	[MessageEventBusDestinationTypeNames.sentry]: defaultMessageEventBusDestinationSentryOptions,
	[MessageEventBusDestinationTypeNames.syslog]: defaultMessageEventBusDestinationSyslogOptions,
};

function onTypeChange(type: string) {
	const preserved = {
		label: working.label,
		enabled: working.enabled,
		subscribedEvents: working.subscribedEvents,
		anonymizeAuditMessages: working.anonymizeAuditMessages,
	};
	Object.assign(working, deepCopy(defaultsByType[type]), preserved);
}

function isEventChecked(group: { name: string }, event: string): boolean {
	const events = working.subscribedEvents ?? [];
	return events.includes(event) || events.includes(group.name);
}

function isGroupChecked(group: { name: string; events: string[] }): boolean {
	const events = working.subscribedEvents ?? [];
	return events.includes(group.name) || group.events.every((event) => events.includes(event));
}

function isGroupIndeterminate(group: { name: string; events: string[] }): boolean {
	if (isGroupChecked(group)) return false;
	const events = working.subscribedEvents ?? [];
	return group.events.some((event) => events.includes(event));
}

function toggleGroup(group: { name: string; events: string[] }, value: boolean) {
	const set = new Set(working.subscribedEvents ?? []);
	group.events.forEach((event) => set.delete(event));
	set.delete(group.name);
	if (value) set.add(group.name);
	working.subscribedEvents = [...set];
}

function toggleEvent(group: { name: string; events: string[] }, event: string, value: boolean) {
	const set = new Set(working.subscribedEvents ?? []);
	// expand a group-level subscription into its members before editing a single one
	if (set.has(group.name)) {
		set.delete(group.name);
		group.events.forEach((name) => set.add(name));
	}
	if (value) set.add(event);
	else set.delete(event);
	// collapse back to the group prefix when every member is subscribed
	if (group.events.every((name) => set.has(name))) {
		group.events.forEach((name) => set.delete(name));
		set.add(group.name);
	}
	working.subscribedEvents = [...set];
}

function toggleExpanded(name: string) {
	const next = new Set(expandedGroups.value);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	expandedGroups.value = next;
}

function groupLabel(name: string): string {
	return i18n.baseText(`settings.log-streaming.eventGroup.${name}` as BaseTextKey);
}

function eventLabel(event: string): string {
	const key = `settings.log-streaming.eventName.${event}`;
	const label = i18n.baseText(key as BaseTextKey);
	return label === key ? event : label;
}

function close() {
	uiStore.closeModal(props.modalName);
}

async function onSave() {
	saving.value = true;
	try {
		await logStreamingStore.saveDestination(working);
		toast.showToast({
			title: i18n.baseText('settings.log-streaming.heading'),
			message: working.label ?? '',
			type: 'success',
		});
		close();
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	} finally {
		saving.value = false;
	}
}

async function onDelete() {
	if (!working.id) return;
	const confirmed = await message.confirm(
		i18n.baseText('settings.log-streaming.destinationDelete.message', {
			interpolate: { destinationName: working.label ?? '' },
		}),
		i18n.baseText('settings.log-streaming.destinationDelete.headline'),
		{
			confirmButtonText: i18n.baseText(
				'settings.log-streaming.destinationDelete.confirmButtonText',
			),
			type: 'warning',
		},
	);
	if (confirmed !== 'confirm') return;

	deleting.value = true;
	try {
		await logStreamingStore.deleteDestination(working.id);
		close();
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	} finally {
		deleting.value = false;
	}
}
</script>

<template>
	<Modal
		width="768px"
		:name="props.modalName"
		:event-bus="props.eventBus"
		data-test-id="event-destination-settings-modal"
	>
		<template #header>
			<N8nHeading tag="h1" size="xlarge">{{ typeLabel }}</N8nHeading>
		</template>
		<template #content>
			<div :class="$style.container">
				<N8nNotice
					v-if="isManagedByEnv"
					theme="warning"
					data-test-id="event-destination-managed-by-env"
				>
					{{ i18n.baseText('settings.log-streaming.managedByEnv') }}
				</N8nNotice>

				<N8nTabs v-model="activeTab" :options="tabOptions" />

				<div v-if="activeTab === 'settings'" :class="$style.tab">
					<N8nInputLabel
						v-if="isNew"
						:label="i18n.baseText('settings.log-streaming.selecttype')"
						:tooltip-text="i18n.baseText('settings.log-streaming.selecttypehint')"
					>
						<N8nSelect
							:model-value="working.__type"
							:disabled="isManagedByEnv"
							data-test-id="event-destination-type-select"
							@update:model-value="onTypeChange"
						>
							<N8nOption
								:value="MessageEventBusDestinationTypeNames.webhook"
								:label="i18n.baseText('settings.log-streaming.$$MessageEventBusDestinationWebhook')"
							/>
							<N8nOption
								:value="MessageEventBusDestinationTypeNames.sentry"
								:label="i18n.baseText('settings.log-streaming.$$MessageEventBusDestinationSentry')"
							/>
							<N8nOption
								:value="MessageEventBusDestinationTypeNames.syslog"
								:label="i18n.baseText('settings.log-streaming.$$MessageEventBusDestinationSyslog')"
							/>
						</N8nSelect>
					</N8nInputLabel>

					<N8nInputLabel :label="i18n.baseText('generic.name')">
						<N8nInput
							v-model="working.label"
							:disabled="isManagedByEnv"
							data-test-id="event-destination-label"
						/>
					</N8nInputLabel>

					<N8nSwitch
						v-model="working.enabled"
						:disabled="isManagedByEnv"
						:label="i18n.baseText('workflowActivator.active')"
						data-test-id="event-destination-enabled"
					/>

					<template v-if="isWebhook">
						<N8nInputLabel label="URL">
							<N8nInput
								v-model="working.url"
								:disabled="isManagedByEnv"
								placeholder="https://"
								data-test-id="event-destination-url"
							/>
						</N8nInputLabel>
						<N8nInputLabel label="Method">
							<N8nSelect v-model="working.method" :disabled="isManagedByEnv">
								<N8nOption v-for="m in methodOptions" :key="m" :value="m" :label="m" />
							</N8nSelect>
						</N8nInputLabel>
					</template>

					<template v-else-if="isSentry">
						<N8nInputLabel label="DSN">
							<N8nInput
								v-model="working.dsn"
								:disabled="isManagedByEnv"
								placeholder="https://"
								data-test-id="event-destination-dsn"
							/>
						</N8nInputLabel>
					</template>

					<template v-else-if="isSyslog">
						<N8nInputLabel label="Host">
							<N8nInput
								v-model="working.host"
								:disabled="isManagedByEnv"
								data-test-id="event-destination-host"
							/>
						</N8nInputLabel>
						<N8nInputLabel label="Port">
							<N8nInputNumber
								v-model="working.port"
								:disabled="isManagedByEnv"
								:min="1"
								:max="65535"
								data-test-id="event-destination-port"
							/>
						</N8nInputLabel>
						<N8nInputLabel label="Protocol">
							<N8nSelect v-model="working.protocol" :disabled="isManagedByEnv">
								<N8nOption v-for="p in protocolOptions" :key="p" :value="p" :label="p" />
							</N8nSelect>
						</N8nInputLabel>
					</template>
				</div>

				<div v-else :class="$style.tab">
					<N8nText size="small" color="text-light">
						{{ i18n.baseText('settings.log-streaming.tab.events.title') }}
					</N8nText>

					<div
						v-for="group in EVENT_GROUPS"
						:key="group.name"
						:class="$style.group"
						:data-test-id="`event-group-${group.name}`"
					>
						<div :class="$style.groupHeader">
							<N8nCheckbox
								:model-value="isGroupChecked(group)"
								:indeterminate="isGroupIndeterminate(group)"
								:disabled="isManagedByEnv"
								:label="groupLabel(group.name)"
								@update:model-value="(value: boolean) => toggleGroup(group, value)"
							/>
							<button
								type="button"
								:class="$style.expandButton"
								:aria-label="group.name"
								@click="toggleExpanded(group.name)"
							>
								<N8nIcon
									:icon="expandedGroups.has(group.name) ? 'chevron-up' : 'chevron-down'"
									size="small"
								/>
							</button>
						</div>
						<div v-if="expandedGroups.has(group.name)" :class="$style.groupEvents">
							<N8nCheckbox
								v-for="event in group.events"
								:key="event"
								:model-value="isEventChecked(group, event)"
								:disabled="isManagedByEnv"
								:label="eventLabel(event)"
								@update:model-value="(value: boolean) => toggleEvent(group, event, value)"
							/>
						</div>
					</div>

					<N8nSwitch
						v-model="working.anonymizeAuditMessages"
						:disabled="isManagedByEnv"
						:label="i18n.baseText('settings.log-streaming.tab.events.anonymize')"
						data-test-id="event-destination-anonymize"
					/>
					<N8nText size="small" color="text-light">
						{{ i18n.baseText('settings.log-streaming.tab.events.anonymize.info') }}
					</N8nText>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					v-if="!isNew"
					variant="ghost"
					:disabled="isManagedByEnv || deleting"
					:loading="deleting"
					:label="i18n.baseText('settings.log-streaming.delete')"
					data-test-id="event-destination-delete"
					@click="onDelete"
				/>
				<N8nButton
					:class="$style.saveButton"
					:loading="saving"
					:disabled="!canSave"
					:label="
						saving
							? i18n.baseText('settings.log-streaming.saving')
							: i18n.baseText('settings.log-streaming.continue')
					"
					data-test-id="event-destination-save"
					@click="onSave"
				/>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--s);
}

.tab {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--s);
	padding-top: var(--spacing--xs);
}

.group {
	display: flex;
	flex-direction: column;
	border-bottom: var(--border);
	padding-bottom: var(--spacing--2xs);
}

.groupHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.expandButton {
	border: none;
	background: transparent;
	cursor: pointer;
	color: var(--color--text--tint-1);
	padding: var(--spacing--4xs);
}

.groupEvents {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	padding-left: var(--spacing--l);
	padding-top: var(--spacing--3xs);
}

.footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--s);
}

.saveButton {
	margin-left: auto;
}
</style>
