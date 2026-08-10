<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n, type BaseTextKey } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import {
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nEmptyState,
	N8nFormInput,
	N8nHeading,
	N8nIcon,
	N8nInput,
	N8nOption,
	N8nSelect,
	N8nSpinner,
	N8nText,
} from '@n8n/design-system';

import { useInjectWorkflowId } from '@/app/composables/useInjectWorkflowId';
import {
	EVALUATIONS_WIZARD_STEPS,
	useEvaluationsWizardSidepanelStore,
} from '../../wizardSidepanel.store';
import { useEvaluationStore } from '../../evaluation.store';
import { useAiRootNodes } from '../../composables/useAiRootNodes';
import type { TestRunRecord, TestRunSummary } from '../../evaluation.types';

defineOptions({ name: 'TestsPanel' });

type MetricTag = 'judge' | 'expression';

interface MetricOption {
	key: string;
	labelKey: BaseTextKey;
	descriptionKey: BaseTextKey;
	tag?: MetricTag;
}

interface TestCaseDraft {
	id: string;
	input: string;
	expected: string;
	seeded: boolean;
}

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const workflowId = useInjectWorkflowId();

const wizardStore = useEvaluationsWizardSidepanelStore();
const evaluationStore = useEvaluationStore();
const aiRootNodes = useAiRootNodes();

const { currentStep, canGoBack } = storeToRefs(wizardStore);

// --- local wizard state ---
const selectedNodeName = ref<string>('');
const selectedMetrics = reactive<Record<string, boolean>>({
	correctness: true,
	helpfulness: false,
	stringSimilarity: false,
	categorization: false,
	toolsUsed: false,
});
const testCases = ref<TestCaseDraft[]>([]);
const isRunning = ref(false);
const isLoadingRuns = ref(false);

const METRIC_OPTIONS: MetricOption[] = [
	{
		key: 'correctness',
		labelKey: 'evaluations.wizardSidepanel.metric.correctness.label',
		descriptionKey: 'evaluations.wizardSidepanel.metric.correctness.description',
		tag: 'judge',
	},
	{
		key: 'helpfulness',
		labelKey: 'evaluations.wizardSidepanel.metric.helpfulness.label',
		descriptionKey: 'evaluations.wizardSidepanel.metric.helpfulness.description',
		tag: 'judge',
	},
	{
		key: 'stringSimilarity',
		labelKey: 'evaluations.wizardSidepanel.metric.stringSimilarity.label',
		descriptionKey: 'evaluations.wizardSidepanel.metric.stringSimilarity.description',
		tag: 'expression',
	},
	{
		key: 'categorization',
		labelKey: 'evaluations.wizardSidepanel.metric.categorization.label',
		descriptionKey: 'evaluations.wizardSidepanel.metric.categorization.description',
	},
	{
		key: 'toolsUsed',
		labelKey: 'evaluations.wizardSidepanel.metric.toolsUsed.label',
		descriptionKey: 'evaluations.wizardSidepanel.metric.toolsUsed.description',
	},
];

const STEPS = EVALUATIONS_WIZARD_STEPS;

const stepTitles = computed(() => [
	i18n.baseText('evaluations.wizardSidepanel.nav.chooseSystem'),
	i18n.baseText('evaluations.wizardSidepanel.nav.setupChecks'),
	i18n.baseText('evaluations.wizardSidepanel.nav.addTestCases'),
	i18n.baseText('evaluations.wizardSidepanel.nav.viewResults'),
]);

const nodeOptions = computed(() =>
	aiRootNodes.value.map((node) => ({ label: node.name, value: node.name })),
);

const hasAiNodes = computed(() => aiRootNodes.value.length > 0);

const selectedMetricCount = computed(() => Object.values(selectedMetrics).filter(Boolean).length);

const latestRun = computed<TestRunSummary | TestRunRecord | undefined>(() => {
	const runs = [...evaluationStore.getTestRuns(workflowId.value)];
	runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return runs[0];
});

const runMetricEntries = computed(() => {
	const metrics = latestRun.value?.metrics ?? null;
	if (!metrics) return [];
	return Object.entries(metrics).map(([key, value]) => ({ key, value }));
});

// Advance the primary button label follows the destination step.
const primaryLabel = computed(() => {
	switch (currentStep.value) {
		case STEPS.CHOOSE_SYSTEM:
			return i18n.baseText('evaluations.wizardSidepanel.nav.next.checks');
		case STEPS.SETUP_CHECKS:
			return i18n.baseText('evaluations.wizardSidepanel.nav.next.cases');
		case STEPS.ADD_TEST_CASES:
			return i18n.baseText('evaluations.wizardSidepanel.nav.next.run');
		default:
			return i18n.baseText('evaluations.wizardSidepanel.nav.runAgain');
	}
});

const primaryDisabled = computed(() => {
	if (currentStep.value === STEPS.CHOOSE_SYSTEM) return !selectedNodeName.value;
	if (currentStep.value === STEPS.SETUP_CHECKS) return selectedMetricCount.value === 0;
	return false;
});

function addTestCase(seeded = false) {
	testCases.value.push({
		id: `case-${Date.now()}-${testCases.value.length}`,
		input: '',
		expected: '',
		seeded,
	});
}

function removeTestCase(id: string) {
	testCases.value = testCases.value.filter((testCase) => testCase.id !== id);
}

async function runTests() {
	isRunning.value = true;
	try {
		await evaluationStore.startTestRun(workflowId.value, {});
		telemetry.track('User ran evaluation from wizard', {
			workflow_id: workflowId.value,
			metric_count: selectedMetricCount.value,
			case_count: testCases.value.length,
		});
		await refreshRuns();
		wizardStore.goToStep(STEPS.RESULTS);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.tests.runAll.error'));
	} finally {
		isRunning.value = false;
	}
}

async function refreshRuns() {
	isLoadingRuns.value = true;
	try {
		await evaluationStore.fetchTestRuns(workflowId.value);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.tests.runAll.error'));
	} finally {
		isLoadingRuns.value = false;
	}
}

async function onPrimary() {
	if (currentStep.value === STEPS.ADD_TEST_CASES) {
		await runTests();
		return;
	}
	if (currentStep.value === STEPS.RESULTS) {
		await runTests();
		return;
	}
	wizardStore.next();
}

function onBack() {
	wizardStore.back();
}

function onCancel() {
	wizardStore.close();
}

onMounted(async () => {
	// Preselect the only AI node so the common single-agent case skips a click.
	if (!selectedNodeName.value && aiRootNodes.value.length === 1) {
		selectedNodeName.value = aiRootNodes.value[0].name;
	}

	// A test case handed off from the executions page: consume it, seed a case
	// and jump straight to the "add cases" step so the handoff is visible.
	const seedExecution = wizardStore.consumePendingSeedExecution();
	if (seedExecution) {
		addTestCase(true);
		wizardStore.goToStep(STEPS.ADD_TEST_CASES);
	}

	await refreshRuns();
});
</script>

<template>
	<div :class="$style.panel" data-test-id="evaluations-tests-panel">
		<header :class="$style.header">
			<div :class="$style.stepIndicator">
				<span
					v-for="(title, index) in stepTitles"
					:key="title"
					:class="[$style.stepDot, { [$style.stepDotActive]: index <= currentStep }]"
					:title="title"
				></span>
			</div>
			<button :class="$style.cancel" data-test-id="evaluations-tests-cancel" @click="onCancel">
				{{ i18n.baseText('evaluations.wizardSidepanel.cancel') }}
			</button>
		</header>

		<div :class="$style.body">
			<!-- Step 0: choose system under test -->
			<section
				v-if="currentStep === STEPS.CHOOSE_SYSTEM"
				data-test-id="evaluations-step-choose-system"
			>
				<N8nHeading tag="h3" size="small" :bold="true">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.chooseSystem.title') }}
				</N8nHeading>
				<N8nText tag="p" size="small" color="text-base" :class="$style.description">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.chooseSystem.description') }}
				</N8nText>

				<N8nEmptyState
					v-if="!hasAiNodes"
					:icon="{ type: 'icon', value: 'flask-conical' }"
					:heading="i18n.baseText('evaluations.tests.empty.noNode')"
				/>
				<template v-else>
					<N8nText tag="label" size="small" :bold="true">
						{{ i18n.baseText('evaluations.wizardSidepanel.step2.aiNode') }}
					</N8nText>
					<N8nSelect
						v-model="selectedNodeName"
						filterable
						:placeholder="i18n.baseText('evaluations.wizardSidepanel.step2.aiNode.placeholder')"
						data-test-id="evaluations-choose-node"
					>
						<N8nOption
							v-for="option in nodeOptions"
							:key="option.value"
							:value="option.value"
							:label="option.label"
						/>
					</N8nSelect>
				</template>
			</section>

			<!-- Step 1: setup checks -->
			<section
				v-else-if="currentStep === STEPS.SETUP_CHECKS"
				data-test-id="evaluations-step-setup-checks"
			>
				<N8nHeading tag="h3" size="small" :bold="true">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.setupChecks.title') }}
				</N8nHeading>
				<N8nText tag="p" size="small" color="text-base" :class="$style.description">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.setupChecks.description') }}
				</N8nText>

				<div
					v-for="metric in METRIC_OPTIONS"
					:key="metric.key"
					:class="$style.metricRow"
					:data-test-id="`evaluations-metric-${metric.key}`"
				>
					<N8nFormInput
						v-model="selectedMetrics[metric.key]"
						type="checkbox"
						:name="`metric-${metric.key}`"
						:label="i18n.baseText(metric.labelKey)"
					/>
					<div :class="$style.metricMeta">
						<N8nBadge v-if="metric.tag === 'judge'" theme="tertiary" size="small">
							{{ i18n.baseText('evaluations.wizardSidepanel.metric.judgeTag') }}
						</N8nBadge>
						<N8nBadge v-else-if="metric.tag === 'expression'" theme="tertiary" size="small">
							{{ i18n.baseText('evaluations.wizardSidepanel.customCheck.expressionTag') }}
						</N8nBadge>
						<N8nText size="xsmall" color="text-light">
							{{ i18n.baseText(metric.descriptionKey) }}
						</N8nText>
					</div>
				</div>
			</section>

			<!-- Step 2: add test cases -->
			<section
				v-else-if="currentStep === STEPS.ADD_TEST_CASES"
				data-test-id="evaluations-step-add-cases"
			>
				<N8nHeading tag="h3" size="small" :bold="true">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.addTestCases.title') }}
				</N8nHeading>
				<N8nText tag="p" size="small" color="text-base" :class="$style.description">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.addTestCases.description') }}
				</N8nText>

				<N8nCallout v-if="testCases.length === 0" theme="info" :class="$style.callout">
					{{ i18n.baseText('evaluations.tests.list.empty') }}
				</N8nCallout>

				<div
					v-for="(testCase, index) in testCases"
					:key="testCase.id"
					:class="$style.caseCard"
					:data-test-id="`evaluations-test-case-${index}`"
				>
					<div :class="$style.caseHeader">
						<N8nText size="small" :bold="true">
							{{
								testCase.seeded
									? i18n.baseText('evaluations.tests.list.seedCaseLabel')
									: i18n.baseText('evaluations.tests.list.caseLabel', {
											interpolate: { index: index + 1 },
										})
							}}
						</N8nText>
						<button
							:class="$style.removeCase"
							:aria-label="i18n.baseText('generic.delete')"
							:data-test-id="`evaluations-test-case-remove-${index}`"
							@click="removeTestCase(testCase.id)"
						>
							<N8nIcon icon="trash-2" size="small" />
						</button>
					</div>
					<N8nInput
						v-model="testCase.input"
						type="textarea"
						:rows="2"
						:placeholder="i18n.baseText('evaluations.wizardSidepanel.step2.input.placeholder')"
					/>
					<N8nInput
						v-model="testCase.expected"
						type="textarea"
						:rows="2"
						:placeholder="i18n.baseText('evaluations.wizardSidepanel.step2.expected.placeholder')"
					/>
				</div>

				<N8nButton
					variant="ghost"
					size="small"
					icon="list-plus"
					data-test-id="evaluations-add-test-case"
					@click="addTestCase(false)"
				>
					{{ i18n.baseText('evaluations.tests.addTestCase') }}
				</N8nButton>
			</section>

			<!-- Step 3: results -->
			<section v-else data-test-id="evaluations-step-results">
				<N8nHeading tag="h3" size="small" :bold="true">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.results.title') }}
				</N8nHeading>
				<N8nText tag="p" size="small" color="text-base" :class="$style.description">
					{{ i18n.baseText('evaluations.wizardSidepanel.step.results.description') }}
				</N8nText>

				<div v-if="isRunning || isLoadingRuns" :class="$style.runningRow">
					<N8nSpinner size="small" />
					<N8nText size="small" color="text-base">
						{{ i18n.baseText('evaluations.wizardSidepanel.step3.running') }}
					</N8nText>
				</div>
				<N8nCallout v-else-if="!latestRun" theme="info" :class="$style.callout">
					{{ i18n.baseText('evaluations.wizardSidepanel.step3.noRun') }}
				</N8nCallout>
				<template v-else>
					<div :class="$style.resultSummary">
						<N8nIcon
							:icon="latestRun.finalResult === 'error' ? 'circle-x' : 'circle-check'"
							:class="latestRun.finalResult === 'error' ? $style.resultError : $style.resultSuccess"
						/>
						<N8nText size="small" :bold="true">
							{{ latestRun.status }}
						</N8nText>
					</div>
					<div
						v-for="metric in runMetricEntries"
						:key="metric.key"
						:class="$style.metricResultRow"
						:data-test-id="`evaluations-result-metric-${metric.key}`"
					>
						<N8nText size="small" color="text-base">{{ metric.key }}</N8nText>
						<N8nText size="small" :bold="true">{{ metric.value }}</N8nText>
					</div>
				</template>
			</section>
		</div>

		<footer :class="$style.footer">
			<N8nButton
				v-if="canGoBack"
				variant="outline"
				size="small"
				icon="arrow-left"
				data-test-id="evaluations-nav-back"
				@click="onBack"
			>
				{{ i18n.baseText('evaluations.wizardSidepanel.nav.back') }}
			</N8nButton>
			<N8nButton
				:loading="isRunning"
				:disabled="primaryDisabled"
				size="small"
				:icon="currentStep === STEPS.RESULTS ? 'refresh-cw' : 'arrow-right'"
				icon-position="right"
				data-test-id="evaluations-nav-primary"
				@click="onPrimary"
			>
				{{ primaryLabel }}
			</N8nButton>
		</footer>
	</div>
</template>

<style lang="scss" module>
.panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	padding: var(--spacing--xs) var(--spacing--sm);
	border-bottom: 1px solid var(--color--foreground);
}

.stepIndicator {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.stepDot {
	width: var(--spacing--2xs);
	height: var(--spacing--2xs);
	border-radius: 50%;
	background: var(--color--foreground);
}

.stepDotActive {
	background: var(--color--primary);
}

.cancel {
	border: none;
	background: transparent;
	cursor: pointer;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
	padding: 0;

	&:hover {
		color: var(--color--text--shade-1);
	}
}

.body {
	flex: 1 1 auto;
	overflow-y: auto;
	padding: var(--spacing--sm);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.description {
	margin: var(--spacing--3xs) 0 var(--spacing--xs);
}

.metricRow {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding: var(--spacing--2xs) 0;
	border-bottom: 1px solid var(--color--foreground--tint-1);
}

.metricMeta {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding-left: var(--spacing--lg);
}

.callout {
	margin: var(--spacing--2xs) 0;
}

.caseCard {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--xs);
	border: 1px solid var(--color--foreground);
	border-radius: var(--radius);
	background: var(--color--background--light-3);
}

.caseHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.removeCase {
	border: none;
	background: transparent;
	cursor: pointer;
	color: var(--color--text--tint-1);
	padding: 0;
	display: inline-flex;

	&:hover {
		color: var(--color--danger);
	}
}

.runningRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.resultSummary {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	margin-bottom: var(--spacing--xs);
}

.resultSuccess {
	color: var(--color--success);
}

.resultError {
	color: var(--color--danger);
}

.metricResultRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: var(--spacing--3xs) 0;
	border-bottom: 1px solid var(--color--foreground--tint-1);
}

.footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	padding: var(--spacing--xs) var(--spacing--sm);
	border-top: 1px solid var(--color--foreground);
}
</style>
