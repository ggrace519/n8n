<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nDataTableServer,
	N8nHeading,
	N8nIcon,
	N8nLoading,
	N8nText,
} from '@n8n/design-system';
import type { IconName, TableHeader } from '@n8n/design-system';

import { VIEWS } from '@/app/constants';
import { useEvaluationStore } from '../evaluation.store';
import type { TestCaseExecutionRecord, TestRunRecord } from '../evaluation.types';

defineOptions({ name: 'TestRunDetailView' });

const props = defineProps<{
	workflowId?: string;
	runId?: string;
}>();

const router = useRouter();
const i18n = useI18n();
const toast = useToast();
const evaluationStore = useEvaluationStore();

const isLoading = ref(true);
const hasError = ref(false);
const run = ref<TestRunRecord | null>(null);

// Metric keys the backend reserves for run bookkeeping — surfaced with dedicated
// labels rather than as user-defined checks.
const RESERVED_METRIC_LABELS: Record<string, string> = {
	promptTokens: i18n.baseText('evaluations.tests.results.metric.promptTokens'),
	completionTokens: i18n.baseText('evaluations.tests.results.metric.completionTokens'),
	totalTokens: i18n.baseText('evaluations.tests.results.metric.totalTokens'),
	executionTime: i18n.baseText('evaluations.tests.results.metric.executionTime'),
};

const cases = computed<TestCaseExecutionRecord[]>(() =>
	evaluationStore.getTestCaseExecutions(props.runId ?? ''),
);

const isEmpty = computed(() => cases.value.length === 0);

const runMetrics = computed<Array<{ name: string; value: string }>>(() => {
	if (!run.value?.metrics) return [];
	return Object.entries(run.value.metrics).map(([name, value]) => ({
		name: RESERVED_METRIC_LABELS[name] ?? name,
		value: formatMetricValue(value),
	}));
});

// Columns are rendered through item slots, so `key` is a plain slot id and each
// carries a no-op `value` accessor to satisfy the TableHeader contract.
const headers = computed<Array<TableHeader<TestCaseExecutionRecord>>>(() => [
	{ title: i18n.baseText('evaluations.tests.list.heading'), key: 'case', value: () => '' },
	{ title: i18n.baseText('evaluations.tests.executions.input'), key: 'input', value: () => '' },
	{ title: i18n.baseText('evaluations.tests.executions.output'), key: 'output', value: () => '' },
	{
		title: i18n.baseText('evaluations.tests.detail.metrics.heading'),
		key: 'metrics',
		value: () => '',
	},
]);

interface StatusMeta {
	theme: 'success' | 'danger' | 'warning' | 'default';
	icon: IconName;
	text?: string;
}

function caseStatusMeta(status: TestCaseExecutionRecord['status']): StatusMeta {
	switch (status) {
		case 'success':
			return { theme: 'success', icon: 'circle-check' };
		case 'error':
			return {
				theme: 'danger',
				icon: 'circle-x',
				text: i18n.baseText('evaluations.tests.results.runFailed'),
			};
		case 'warning':
			return { theme: 'warning', icon: 'triangle-alert' };
		case 'cancelled':
			return { theme: 'default', icon: 'circle-x' };
		default:
			return {
				theme: 'default',
				icon: 'circle-play',
				text: i18n.baseText('evaluations.tests.results.running'),
			};
	}
}

function formatMetricValue(value: number | boolean): string {
	return typeof value === 'boolean' ? String(value) : String(Math.round(value * 100) / 100);
}

function summarize(value: Record<string, unknown> | null): string {
	if (!value) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
}

function caseMetrics(testCase: TestCaseExecutionRecord): Array<{ name: string; value: string }> {
	if (!testCase.metrics) return [];
	return Object.entries(testCase.metrics).map(([name, value]) => ({
		name: RESERVED_METRIC_LABELS[name] ?? name,
		value: formatMetricValue(value),
	}));
}

async function load() {
	if (!props.workflowId || !props.runId) {
		isLoading.value = false;
		return;
	}
	isLoading.value = true;
	hasError.value = false;
	try {
		const [fetchedRun] = await Promise.all([
			evaluationStore.fetchTestRun(props.workflowId, props.runId),
			evaluationStore.fetchTestCaseExecutions(props.workflowId, props.runId),
		]);
		run.value = fetchedRun;
	} catch (error) {
		hasError.value = true;
		toast.showError(error, i18n.baseText('generic.error'));
	} finally {
		isLoading.value = false;
	}
}

function goBack() {
	void router.push({
		name: VIEWS.EVALUATION_EDIT,
		params: { workflowId: props.workflowId },
	});
}

onMounted(load);
</script>

<template>
	<div :class="$style.container" data-test-id="test-run-detail-view">
		<div :class="$style.header">
			<N8nButton
				variant="subtle"
				size="small"
				icon="arrow-left"
				data-test-id="test-run-detail-back"
				@click="goBack"
			>
				{{ i18n.baseText('generic.back') }}
			</N8nButton>
			<N8nHeading tag="h2" size="large">
				{{ i18n.baseText('evaluations.wizardSidepanel.step.results.title') }}
			</N8nHeading>
			<N8nText color="text-base">
				{{ i18n.baseText('evaluations.wizardSidepanel.step.results.description') }}
			</N8nText>
		</div>

		<N8nLoading v-if="isLoading" :rows="6" />

		<N8nCallout v-else-if="hasError" theme="danger">
			{{ i18n.baseText('generic.error') }}
			<template #trailingContent>
				<N8nButton variant="subtle" size="small" @click="load">
					{{ i18n.baseText('generic.retry') }}
				</N8nButton>
			</template>
		</N8nCallout>

		<template v-else>
			<div v-if="runMetrics.length" :class="$style.summary">
				<N8nText size="small" color="text-light" :bold="true">
					{{ i18n.baseText('evaluations.wizardSidepanel.step3.averageLabel') }}
				</N8nText>
				<div :class="$style.metrics">
					<N8nBadge v-for="metric in runMetrics" :key="metric.name" theme="default">
						{{ metric.name }}: {{ metric.value }}
					</N8nBadge>
				</div>
			</div>

			<N8nText v-if="isEmpty" color="text-base" :class="$style.empty">
				{{ i18n.baseText('evaluations.tests.results.empty') }}
			</N8nText>

			<N8nDataTableServer
				v-else
				:headers="headers"
				:items="cases"
				:items-length="cases.length"
				data-test-id="test-run-cases-table"
			>
				<template #[`item.case`]="{ item }">
					<div :class="$style.caseCell">
						<N8nBadge :theme="caseStatusMeta(item.status).theme" :class="$style.statusBadge">
							<N8nIcon :icon="caseStatusMeta(item.status).icon" size="xsmall" />
							<span v-if="caseStatusMeta(item.status).text" :class="$style.statusText">
								{{ caseStatusMeta(item.status).text }}
							</span>
						</N8nBadge>
						<N8nText size="small">
							{{
								i18n.baseText('evaluations.wizardSidepanel.step3.caseLabel', {
									interpolate: { index: String((item.runIndex ?? 0) + 1) },
								})
							}}
						</N8nText>
					</div>
				</template>
				<template #[`item.input`]="{ item }">
					<N8nText size="small" color="text-base" :class="$style.truncate">
						{{ summarize(item.inputs) }}
					</N8nText>
				</template>
				<template #[`item.output`]="{ item }">
					<N8nText size="small" color="text-base" :class="$style.truncate">
						{{ summarize(item.outputs) }}
					</N8nText>
				</template>
				<template #[`item.metrics`]="{ item }">
					<div :class="$style.metrics">
						<N8nBadge v-for="metric in caseMetrics(item)" :key="metric.name" theme="default">
							{{ metric.name }}: {{ metric.value }}
						</N8nBadge>
					</div>
				</template>
			</N8nDataTableServer>
		</template>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--lg);
	width: 100%;
	max-width: 1100px;
	margin: 0 auto;
}

.header {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	align-items: flex-start;
}

.summary {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
	background: var(--color--background--light-3);
	border: 1px solid var(--color--foreground);
	border-radius: var(--radius--md);
}

.metrics {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--5xs);
}

.caseCell {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.statusBadge {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--5xs);
}

.statusText {
	margin-left: var(--spacing--5xs);
}

.truncate {
	display: block;
	max-width: 320px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.empty {
	padding: var(--spacing--lg);
	text-align: center;
}
</style>
