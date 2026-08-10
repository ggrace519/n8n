<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { normalizeMetricScore } from '@n8n/api-types';
import type { AiInsightsResponse } from '@n8n/api-types';
import {
	N8nButton,
	N8nCallout,
	N8nCard,
	N8nHeading,
	N8nIcon,
	N8nLoading,
	N8nText,
} from '@n8n/design-system';

import { VIEWS } from '@/app/constants';
import { useEvaluationStore } from '../evaluation.store';
import type {
	EvaluationCollectionDetail,
	EvaluationCollectionRunSummary,
} from '../evaluation.types';

defineOptions({ name: 'CompareCollectionView' });

const props = defineProps<{
	workflowId?: string;
	collectionId?: string;
}>();

const router = useRouter();
const i18n = useI18n();
const toast = useToast();
const evaluationStore = useEvaluationStore();

const isLoading = ref(true);
const hasError = ref(false);
const isGenerating = ref(false);
const collection = ref<EvaluationCollectionDetail | null>(null);
const insights = ref<AiInsightsResponse | null>(null);

const runs = computed<EvaluationCollectionRunSummary[]>(() => collection.value?.runs ?? []);

// Union of user-defined metric keys across all runs, preserving first-seen order.
const metricKeys = computed<string[]>(() => {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const run of runs.value) {
		for (const key of Object.keys(run.metrics ?? {})) {
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
	}
	return keys;
});

function columnLabel(run: EvaluationCollectionRunSummary, index: number): string {
	if (run.workflowVersionId) return run.workflowVersionId.slice(0, 8);
	return `#${index + 1}`;
}

function scaleFor(run: EvaluationCollectionRunSummary, key: string) {
	return run.metricScales?.[key] ?? collection.value?.metricScales?.[key];
}

function cellValue(run: EvaluationCollectionRunSummary, key: string): string {
	const raw = run.metrics?.[key];
	if (raw === undefined || raw === null) return '—';
	const normalized = normalizeMetricScore(key, raw, scaleFor(run, key));
	if (normalized === null) return String(Math.round(raw * 100) / 100);
	return `${Math.round(normalized * 100)}%`;
}

function averageValue(run: EvaluationCollectionRunSummary): string {
	if (run.avgScore === null || run.avgScore === undefined) return '—';
	return `${Math.round(run.avgScore * 100)}%`;
}

function formatDelta(delta: number): string {
	const sign = delta > 0 ? '+' : '';
	return `${sign}${Math.round(delta * 10) / 10}%`;
}

async function load() {
	if (!props.workflowId || !props.collectionId) {
		isLoading.value = false;
		return;
	}
	isLoading.value = true;
	hasError.value = false;
	try {
		collection.value = await evaluationStore.fetchCollection(props.workflowId, props.collectionId);
		const envelope = await evaluationStore
			.fetchInsights(props.workflowId, props.collectionId)
			.catch(() => null);
		insights.value = envelope?.data ?? null;
	} catch (error) {
		hasError.value = true;
		toast.showError(error, i18n.baseText('generic.error'));
	} finally {
		isLoading.value = false;
	}
}

async function regenerateInsights() {
	if (!props.workflowId || !props.collectionId) return;
	isGenerating.value = true;
	try {
		insights.value = await evaluationStore.generateInsights(props.workflowId, props.collectionId, {
			forceRegenerate: true,
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('generic.error'));
	} finally {
		isGenerating.value = false;
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
	<div :class="$style.container" data-test-id="compare-collection-view">
		<div :class="$style.header">
			<N8nButton
				variant="subtle"
				size="small"
				icon="arrow-left"
				data-test-id="compare-collection-back"
				@click="goBack"
			>
				{{ i18n.baseText('generic.back') }}
			</N8nButton>
			<N8nHeading tag="h2" size="large">
				{{ collection?.name ?? i18n.baseText('evaluations.wizardSidepanel.step.results.title') }}
			</N8nHeading>
			<N8nText v-if="collection?.description" color="text-base">
				{{ collection.description }}
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
			<!-- AI insights -->
			<N8nCard v-if="insights" :class="$style.insights" data-test-id="compare-collection-insights">
				<div :class="$style.insightItem">
					<N8nIcon icon="star-filled" :class="$style.winnerIcon" />
					<div>
						<N8nText :bold="true">
							{{ insights.insights.winner.versionLabel }} — {{ insights.insights.winner.headline }}
						</N8nText>
						<N8nText tag="p" size="small" color="text-base">
							{{ insights.insights.winner.body }}
						</N8nText>
					</div>
				</div>

				<div
					v-for="(regression, index) in insights.insights.regressions"
					:key="`regression-${index}`"
					:class="$style.insightItem"
				>
					<N8nIcon icon="triangle-alert" :class="$style.regressionIcon" />
					<div>
						<N8nText :bold="true">
							{{ regression.versionLabel }} · {{ regression.metric }} ({{
								formatDelta(regression.delta)
							}}) — {{ regression.headline }}
						</N8nText>
						<N8nText tag="p" size="small" color="text-base">{{ regression.body }}</N8nText>
					</div>
				</div>

				<div :class="$style.insightItem">
					<N8nIcon icon="wand-sparkles" :class="$style.suggestIcon" />
					<div>
						<N8nText :bold="true">{{ insights.insights.suggestedNext.headline }}</N8nText>
						<N8nText tag="p" size="small" color="text-base">
							{{ insights.insights.suggestedNext.body }}
						</N8nText>
						<N8nText tag="p" size="small" color="text-light">
							{{ insights.insights.suggestedNext.hypothesis }}
						</N8nText>
					</div>
				</div>
			</N8nCard>

			<div :class="$style.insightsActions">
				<N8nButton
					variant="outline"
					size="small"
					icon="wand-sparkles"
					:loading="isGenerating"
					data-test-id="compare-collection-regenerate"
					@click="regenerateInsights"
				>
					{{ i18n.baseText('generic.retry') }}
				</N8nButton>
			</div>

			<!-- Comparison matrix -->
			<div :class="$style.tableWrapper">
				<table :class="$style.table" data-test-id="compare-collection-table">
					<thead>
						<tr>
							<th :class="$style.metricHead">
								{{ i18n.baseText('evaluations.tests.detail.metrics.heading') }}
							</th>
							<th v-for="(run, index) in runs" :key="run.testRunId" :class="$style.runHead">
								{{ columnLabel(run, index) }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr :class="$style.averageRow">
							<td :class="$style.metricName">
								{{ i18n.baseText('evaluations.wizardSidepanel.step3.averageLabel') }}
							</td>
							<td v-for="run in runs" :key="`avg-${run.testRunId}`" :class="$style.cell">
								{{ averageValue(run) }}
							</td>
						</tr>
						<tr v-for="key in metricKeys" :key="key">
							<td :class="$style.metricName">{{ key }}</td>
							<td v-for="run in runs" :key="`${key}-${run.testRunId}`" :class="$style.cell">
								{{ cellValue(run, key) }}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
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

.insights {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.insightItem {
	display: flex;
	gap: var(--spacing--xs);
	align-items: flex-start;
}

.winnerIcon {
	color: var(--color--success);
}

.regressionIcon {
	color: var(--color--warning);
}

.suggestIcon {
	color: var(--color--primary);
}

.insightsActions {
	display: flex;
	justify-content: flex-end;
}

.tableWrapper {
	width: 100%;
	overflow-x: auto;
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: var(--font-size--2xs);
}

.metricHead,
.runHead {
	text-align: left;
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: 1px solid var(--color--foreground);
	color: var(--color--text--tint-1);
	font-weight: var(--font-weight--bold);
	white-space: nowrap;
}

.runHead {
	text-align: center;
}

.metricName {
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: 1px solid var(--color--foreground--tint-1);
	white-space: nowrap;
}

.cell {
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: 1px solid var(--color--foreground--tint-1);
	text-align: center;
}

.averageRow {
	font-weight: var(--font-weight--bold);
	background: var(--color--background--light-3);
}
</style>
