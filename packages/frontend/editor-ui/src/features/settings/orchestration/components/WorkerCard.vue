<script lang="ts" setup>
import { computed } from 'vue';
import type { WorkerStatus } from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useClipboard } from '@n8n/composables/useClipboard';
import { N8nCard, N8nHeading, N8nIcon, N8nText } from '@n8n/design-system';

const props = defineProps<{
	worker: WorkerStatus;
	lastUpdated: number;
}>();

const i18n = useI18n();
const toast = useToast();
const clipboard = useClipboard();

/** External (non-internal) addresses reported by the worker, if any. */
const externalInterfaces = computed(() =>
	props.worker.interfaces.filter((netInterface) => !netInterface.internal),
);

const primaryAddress = computed(() => externalInterfaces.value[0]?.address ?? '');

const lastUpdatedLabel = computed(() =>
	props.lastUpdated ? new Date(props.lastUpdated).toLocaleTimeString() : '',
);

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / Math.pow(1024, exponent);
	return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (!parts.length) parts.push(`${Math.floor(seconds)}s`);
	return parts.join(' ');
}

const hostMemoryUsed = computed(() => props.worker.totalMem - props.worker.freeMem);

async function copyAddress() {
	if (!primaryAddress.value) return;
	await clipboard.copy(primaryAddress.value);
	toast.showMessage({
		title: i18n.baseText('workerList.item.copyAddressToClipboard'),
		type: 'success',
	});
}
</script>

<template>
	<N8nCard :class="$style.card" :data-test-id="`worker-card-${worker.senderId}`">
		<div :class="$style.header">
			<div :class="$style.identity">
				<N8nIcon icon="waypoints" :class="$style.headerIcon" />
				<div :class="$style.titleGroup">
					<N8nHeading tag="h2" size="medium" bold>{{ worker.hostname }}</N8nHeading>
					<N8nText size="small" color="text-light">{{ worker.senderId }}</N8nText>
				</div>
			</div>
			<div :class="$style.headerMeta">
				<N8nText
					v-if="primaryAddress"
					size="small"
					color="text-light"
					:class="$style.address"
					data-test-id="worker-card-address"
					@click="copyAddress"
				>
					{{ primaryAddress }}
					<N8nIcon icon="clipboard-list" size="small" />
				</N8nText>
				<N8nText v-if="lastUpdatedLabel" size="small" color="text-light">
					{{ i18n.baseText('workerList.item.lastUpdated') }}: {{ lastUpdatedLabel }}
				</N8nText>
			</div>
		</div>

		<div :class="$style.metrics">
			<div :class="$style.metric">
				<N8nText size="small" color="text-light">{{
					i18n.baseText('workerList.item.jobListTitle')
				}}</N8nText>
				<N8nText bold>{{ worker.runningJobsSummary.length }}</N8nText>
			</div>
			<div :class="$style.metric">
				<N8nText size="small" color="text-light">CPU</N8nText>
				<N8nText bold>{{ worker.cpus }}</N8nText>
			</div>
			<div :class="$style.metric">
				<N8nText size="small" color="text-light">Uptime</N8nText>
				<N8nText bold>{{ formatUptime(worker.uptime) }}</N8nText>
			</div>
			<div :class="$style.metric">
				<N8nText size="small" color="text-light">Version</N8nText>
				<N8nText bold>{{ worker.version }}</N8nText>
			</div>
		</div>

		<div :class="$style.section">
			<N8nText size="small" color="text-light" :class="$style.sectionTitle">
				<N8nIcon icon="hard-drive" size="small" />
				{{ i18n.baseText('workerList.item.memoryMonitorTitle') }}
			</N8nText>
			<div :class="$style.memoryRows">
				<div :class="$style.memoryRow">
					<N8nText size="small" color="text-light">Process (RSS)</N8nText>
					<N8nText size="small">{{ formatBytes(worker.process.memory.rss) }}</N8nText>
				</div>
				<div :class="$style.memoryRow">
					<N8nText size="small" color="text-light">Heap</N8nText>
					<N8nText size="small"
						>{{ formatBytes(worker.process.memory.heapUsed) }} /
						{{ formatBytes(worker.process.memory.heapTotal) }}</N8nText
					>
				</div>
				<div :class="$style.memoryRow">
					<N8nText size="small" color="text-light">Host</N8nText>
					<N8nText size="small"
						>{{ formatBytes(hostMemoryUsed) }} / {{ formatBytes(worker.totalMem) }}</N8nText
					>
				</div>
			</div>
		</div>

		<div :class="$style.section">
			<N8nText size="small" color="text-light" :class="$style.sectionTitle">
				<N8nIcon icon="clipboard-list" size="small" />
				{{ i18n.baseText('workerList.item.jobListTitle') }}
			</N8nText>
			<N8nText
				v-if="worker.runningJobsSummary.length === 0"
				size="small"
				color="text-light"
				data-test-id="worker-card-jobs-empty"
			>
				{{ i18n.baseText('workerList.item.jobList.empty') }}
			</N8nText>
			<ul v-else :class="$style.jobList">
				<li v-for="job in worker.runningJobsSummary" :key="job.executionId" :class="$style.jobItem">
					<N8nText size="small" bold>{{ job.workflowName || job.workflowId }}</N8nText>
					<N8nText size="small" color="text-light"
						>#{{ job.executionId }} · {{ job.status }}</N8nText
					>
				</li>
			</ul>
		</div>

		<div v-if="externalInterfaces.length" :class="$style.section">
			<N8nText size="small" color="text-light" :class="$style.sectionTitle">
				<N8nIcon icon="waypoints" size="small" />
				{{ i18n.baseText('workerList.item.netListTitle') }}
			</N8nText>
			<ul :class="$style.netList">
				<li
					v-for="netInterface in externalInterfaces"
					:key="`${netInterface.family}-${netInterface.address}`"
					:class="$style.netItem"
				>
					<N8nText size="small">{{ netInterface.address }}</N8nText>
					<N8nText size="small" color="text-light">{{ netInterface.family }}</N8nText>
				</li>
			</ul>
		</div>
	</N8nCard>
</template>

<style lang="scss" module>
.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--s);
}

.header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--s);
	flex-wrap: wrap;
}

.identity {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.headerIcon {
	color: var(--color--text--tint-1);
}

.titleGroup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
}

.headerMeta {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: var(--spacing--5xs);
}

.address {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--5xs);
	cursor: pointer;
}

.metrics {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
	gap: var(--spacing--s);
	padding: var(--spacing--s) 0;
	border-top: var(--border);
	border-bottom: var(--border);
}

.metric {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.sectionTitle {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--5xs);
}

.memoryRows,
.jobList,
.netList {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	margin: 0;
	padding: 0;
	list-style: none;
}

.memoryRow,
.jobItem,
.netItem {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--s);
}
</style>
