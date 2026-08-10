<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import {
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nCard,
	N8nEmptyState,
	N8nHeading,
	N8nIcon,
	N8nLoading,
	N8nText,
} from '@n8n/design-system';
import type { IconName } from '@n8n/design-system';

import { VIEWS } from '@/app/constants';
import { useEvaluationStore } from '../evaluation.store';
import type { TestRunSummary } from '../evaluation.types';

defineOptions({ name: 'EvaluationsListSwitcher' });

const props = defineProps<{
	workflowId?: string;
}>();

const router = useRouter();
const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const evaluationStore = useEvaluationStore();

const isLoading = ref(true);
const hasError = ref(false);
const deletingId = ref<string | null>(null);

const runs = computed(() => {
	const list = [...evaluationStore.getTestRuns(props.workflowId ?? '')] as TestRunSummary[];
	return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
});

const isEmpty = computed(() => runs.value.length === 0);

const valueProps = computed(() => [
	{
		icon: 'circle-check' as IconName,
		title: i18n.baseText('evaluations.emptyState.buildConfidence.title'),
		description: i18n.baseText('evaluations.emptyState.buildConfidence.description'),
	},
	{
		icon: 'triangle-alert' as IconName,
		title: i18n.baseText('evaluations.emptyState.catchIssues.title'),
		description: i18n.baseText('evaluations.emptyState.catchIssues.description'),
	},
	{
		icon: 'chart-bar' as IconName,
		title: i18n.baseText('evaluations.emptyState.measurePerformance.title'),
		description: i18n.baseText('evaluations.emptyState.measurePerformance.description'),
	},
]);

interface StatusMeta {
	theme: 'success' | 'danger' | 'warning' | 'default';
	icon: IconName;
	text?: string;
}

function statusMeta(run: TestRunSummary): StatusMeta {
	if (run.status === 'running' || run.status === 'new') {
		return {
			theme: 'default',
			icon: 'circle-play',
			text: i18n.baseText('evaluations.tests.results.running'),
		};
	}
	if (run.status === 'error' || run.finalResult === 'error') {
		return {
			theme: 'danger',
			icon: 'circle-x',
			text: i18n.baseText('evaluations.tests.results.runFailed'),
		};
	}
	if (run.finalResult === 'warning' || run.status === 'cancelled') {
		return { theme: 'warning', icon: 'triangle-alert' };
	}
	return { theme: 'success', icon: 'circle-check' };
}

function formatDate(value: string | null): string {
	if (!value) return '';
	return new Date(value).toLocaleString();
}

function runLabel(run: TestRunSummary, index: number): string {
	return i18n.baseText('evaluations.tests.results.runLabel', {
		interpolate: { number: String(runs.value.length - index), date: formatDate(run.createdAt) },
	});
}

function metricEntries(run: TestRunSummary): Array<{ name: string; value: string }> {
	if (!run.metrics) return [];
	return Object.entries(run.metrics).map(([name, value]) => ({
		name,
		value: typeof value === 'boolean' ? String(value) : String(Math.round(value * 100) / 100),
	}));
}

async function load() {
	if (!props.workflowId) {
		isLoading.value = false;
		return;
	}
	isLoading.value = true;
	hasError.value = false;
	try {
		await evaluationStore.fetchTestRuns(props.workflowId);
	} catch (error) {
		hasError.value = true;
		toast.showError(error, i18n.baseText('generic.error'));
	} finally {
		isLoading.value = false;
	}
}

function openRun(run: TestRunSummary) {
	void router.push({
		name: VIEWS.EVALUATION_RUNS_DETAIL,
		params: { workflowId: props.workflowId, runId: run.id },
	});
}

async function onDelete(run: TestRunSummary, event: MouseEvent) {
	event.stopPropagation();
	if (!props.workflowId) return;
	deletingId.value = run.id;
	try {
		await evaluationStore.deleteTestRun(props.workflowId, run.id);
		telemetry.track('User deleted test run', { workflow_id: props.workflowId });
	} catch (error) {
		toast.showError(error, i18n.baseText('generic.error'));
	} finally {
		deletingId.value = null;
	}
}

function goToEditor() {
	void router.push({ name: VIEWS.WORKFLOW, params: { workflowId: props.workflowId } });
}

onMounted(load);
</script>

<template>
	<div :class="$style.container" data-test-id="evaluations-list-switcher">
		<N8nLoading v-if="isLoading" :rows="5" />

		<N8nCallout v-else-if="hasError" theme="danger" :class="$style.callout">
			{{ i18n.baseText('generic.error') }}
			<template #trailingContent>
				<N8nButton variant="subtle" size="small" @click="load">
					{{ i18n.baseText('generic.retry') }}
				</N8nButton>
			</template>
		</N8nCallout>

		<div v-else-if="isEmpty" :class="$style.empty">
			<N8nEmptyState
				:icon="{ type: 'icon', value: 'flask-conical' }"
				:heading="i18n.baseText('evaluations.emptyState.title')"
				:description="i18n.baseText('evaluations.emptyState.description')"
				:button-text="i18n.baseText('evaluations.emptyState.getStarted')"
				button-variant="solid"
				@click:button="goToEditor"
			/>
			<div :class="$style.valueProps">
				<N8nCard v-for="prop in valueProps" :key="prop.title" :class="$style.valueCard">
					<template #prepend>
						<N8nIcon :icon="prop.icon" :class="$style.valueIcon" />
					</template>
					<template #header>
						<N8nText tag="span" :bold="true">{{ prop.title }}</N8nText>
					</template>
					<N8nText size="small" color="text-base">{{ prop.description }}</N8nText>
				</N8nCard>
			</div>
		</div>

		<div v-else :class="$style.list">
			<N8nHeading tag="h2" size="large" :class="$style.title">
				{{ i18n.baseText('evaluations.emptyState.title') }}
			</N8nHeading>
			<N8nCard
				v-for="(run, index) in runs"
				:key="run.id"
				hoverable
				:class="$style.runCard"
				:data-test-id="`test-run-row-${run.id}`"
				@click="openRun(run)"
			>
				<div :class="$style.runRow">
					<div :class="$style.runMain">
						<N8nBadge :theme="statusMeta(run).theme" :class="$style.statusBadge">
							<N8nIcon :icon="statusMeta(run).icon" size="xsmall" />
							<span v-if="statusMeta(run).text" :class="$style.statusText">
								{{ statusMeta(run).text }}
							</span>
						</N8nBadge>
						<N8nText :bold="true">{{ runLabel(run, index) }}</N8nText>
					</div>
					<div :class="$style.runMeta">
						<N8nText size="small" color="text-light">
							{{
								i18n.baseText('evaluations.tests.list.caseLabel', {
									interpolate: { index: String(run.testCaseCount ?? 0) },
								})
							}}
						</N8nText>
						<div :class="$style.metrics">
							<N8nBadge v-for="metric in metricEntries(run)" :key="metric.name" theme="default">
								{{ metric.name }}: {{ metric.value }}
							</N8nBadge>
						</div>
						<N8nButton
							variant="subtle"
							size="small"
							icon="trash-2"
							:loading="deletingId === run.id"
							:aria-label="i18n.baseText('generic.delete')"
							:data-test-id="`test-run-delete-${run.id}`"
							@click="(event: MouseEvent) => onDelete(run, event)"
						/>
					</div>
				</div>
			</N8nCard>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--lg);
	width: 100%;
	max-width: 960px;
	margin: 0 auto;
}

.callout {
	margin-top: var(--spacing--sm);
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--xl);
	padding-top: var(--spacing--xl);
}

.valueProps {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--spacing--sm);
	width: 100%;
}

.valueCard {
	height: 100%;
}

.valueIcon {
	color: var(--color--primary);
}

.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.title {
	margin-bottom: var(--spacing--xs);
}

.runCard {
	cursor: pointer;
}

.runRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	width: 100%;
}

.runMain {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
	min-width: 0;
}

.runMeta {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
	flex-shrink: 0;
}

.statusBadge {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--5xs);
}

.statusText {
	margin-left: var(--spacing--5xs);
}

.metrics {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--5xs);
}
</style>
