import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { STORES } from '@n8n/stores';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type {
	AddRunToCollectionPayload,
	CreateEvaluationCollectionPayload,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
	StartTestRunPayload,
	UpdateEvaluationCollectionPayload,
} from '@n8n/api-types';

import * as evaluationApi from './evaluation.api';
import type {
	EvaluationConfig,
	GetTestRunsQuery,
	TestCaseExecutionRecord,
	TestRunRecord,
	TestRunSummary,
	UpsertEvaluationConfigPayload,
} from './evaluation.types';

/**
 * Client state for the config-based evaluation surface: test runs, evaluation
 * configs and comparison collections. Backed by the E13 REST controllers.
 */
export const useEvaluationStore = defineStore(STORES.EVALUATION, () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	// Test runs keyed by workflow id, then by run id, so switching workflows
	// never renders another workflow's runs.
	const testRunsByWorkflowId = ref<Record<string, Record<string, TestRunSummary | TestRunRecord>>>(
		{},
	);
	const testCaseExecutionsByRunId = ref<Record<string, TestCaseExecutionRecord[]>>({});
	const configsByWorkflowId = ref<Record<string, EvaluationConfig[]>>({});
	const collectionsByWorkflowId = ref<Record<string, EvaluationCollectionRecord[]>>({});

	/**
	 * Whether the config-based evaluation feature is available on this instance.
	 * There is no enterprise licence for evaluations in this fork — availability
	 * is driven by the operator overrides / PostHog flags surfaced on settings,
	 * and by the quota (a quota of 0 means the instance is not entitled).
	 */
	const isEvaluationEnabled = computed(() => {
		const evaluation = settingsStore.settings.evaluation;
		// Evaluations ship ungated in this fork; only an explicit backend quota of 0
		// (with no config override) turns them off.
		if (!evaluation) return true;
		return (
			evaluation.quota !== 0 ||
			evaluation.configEvalsEnabled === true ||
			evaluation.collectionsEnabled === true
		);
	});

	const getTestRuns = (workflowId: string) =>
		Object.values(testRunsByWorkflowId.value[workflowId] ?? {});

	function cacheTestRun(workflowId: string, run: TestRunSummary | TestRunRecord) {
		const existing = testRunsByWorkflowId.value[workflowId] ?? {};
		testRunsByWorkflowId.value = {
			...testRunsByWorkflowId.value,
			[workflowId]: { ...existing, [run.id]: run },
		};
	}

	async function fetchTestRuns(workflowId: string, query: GetTestRunsQuery = {}) {
		const runs = await evaluationApi.getTestRuns(rootStore.restApiContext, workflowId, query);
		testRunsByWorkflowId.value = {
			...testRunsByWorkflowId.value,
			[workflowId]: runs.reduce<Record<string, TestRunSummary>>((acc, run) => {
				acc[run.id] = run;
				return acc;
			}, {}),
		};
		return runs;
	}

	async function fetchTestRun(workflowId: string, testRunId: string) {
		const run = await evaluationApi.getTestRun(rootStore.restApiContext, workflowId, testRunId);
		cacheTestRun(workflowId, run);
		return run;
	}

	async function fetchTestCaseExecutions(workflowId: string, testRunId: string) {
		const cases = await evaluationApi.getTestCaseExecutions(
			rootStore.restApiContext,
			workflowId,
			testRunId,
		);
		testCaseExecutionsByRunId.value = {
			...testCaseExecutionsByRunId.value,
			[testRunId]: cases,
		};
		return cases;
	}

	const getTestCaseExecutions = (testRunId: string) =>
		testCaseExecutionsByRunId.value[testRunId] ?? [];

	async function startTestRun(workflowId: string, payload: StartTestRunPayload = {}) {
		return await evaluationApi.startTestRun(rootStore.restApiContext, workflowId, payload);
	}

	async function cancelTestRun(workflowId: string, testRunId: string) {
		return await evaluationApi.cancelTestRun(rootStore.restApiContext, workflowId, testRunId);
	}

	async function deleteTestRun(workflowId: string, testRunId: string) {
		const result = await evaluationApi.deleteTestRun(
			rootStore.restApiContext,
			workflowId,
			testRunId,
		);
		const forWorkflow = { ...(testRunsByWorkflowId.value[workflowId] ?? {}) };
		delete forWorkflow[testRunId];
		testRunsByWorkflowId.value = { ...testRunsByWorkflowId.value, [workflowId]: forWorkflow };
		return result;
	}

	// --- evaluation configs ---

	const getConfigs = (workflowId: string) => configsByWorkflowId.value[workflowId] ?? [];

	async function fetchEvaluationConfigs(workflowId: string) {
		const configs = await evaluationApi.getEvaluationConfigs(rootStore.restApiContext, workflowId);
		configsByWorkflowId.value = { ...configsByWorkflowId.value, [workflowId]: configs };
		return configs;
	}

	async function fetchEvaluationConfig(workflowId: string, configId: string) {
		return await evaluationApi.getEvaluationConfig(rootStore.restApiContext, workflowId, configId);
	}

	async function createEvaluationConfig(
		workflowId: string,
		payload: UpsertEvaluationConfigPayload,
	) {
		const config = await evaluationApi.createEvaluationConfig(
			rootStore.restApiContext,
			workflowId,
			payload,
		);
		await fetchEvaluationConfigs(workflowId).catch(() => null);
		return config;
	}

	async function updateEvaluationConfig(
		workflowId: string,
		configId: string,
		payload: UpsertEvaluationConfigPayload,
	) {
		const config = await evaluationApi.updateEvaluationConfig(
			rootStore.restApiContext,
			workflowId,
			configId,
			payload,
		);
		await fetchEvaluationConfigs(workflowId).catch(() => null);
		return config;
	}

	async function deleteEvaluationConfig(workflowId: string, configId: string) {
		const result = await evaluationApi.deleteEvaluationConfig(
			rootStore.restApiContext,
			workflowId,
			configId,
		);
		await fetchEvaluationConfigs(workflowId).catch(() => null);
		return result;
	}

	// --- comparison collections ---

	const getCollections = (workflowId: string) => collectionsByWorkflowId.value[workflowId] ?? [];

	async function fetchCollections(workflowId: string) {
		const collections = await evaluationApi.getCollections(rootStore.restApiContext, workflowId);
		collectionsByWorkflowId.value = {
			...collectionsByWorkflowId.value,
			[workflowId]: collections,
		};
		return collections;
	}

	async function fetchCollection(
		workflowId: string,
		collectionId: string,
	): Promise<EvaluationCollectionDetail> {
		return await evaluationApi.getCollection(rootStore.restApiContext, workflowId, collectionId);
	}

	async function createCollection(workflowId: string, payload: CreateEvaluationCollectionPayload) {
		const collection = await evaluationApi.createCollection(
			rootStore.restApiContext,
			workflowId,
			payload,
		);
		await fetchCollections(workflowId).catch(() => null);
		return collection;
	}

	async function updateCollection(
		workflowId: string,
		collectionId: string,
		payload: UpdateEvaluationCollectionPayload,
	) {
		const collection = await evaluationApi.updateCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			payload,
		);
		await fetchCollections(workflowId).catch(() => null);
		return collection;
	}

	async function deleteCollection(workflowId: string, collectionId: string) {
		const result = await evaluationApi.deleteCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
		);
		await fetchCollections(workflowId).catch(() => null);
		return result;
	}

	async function addRunToCollection(
		workflowId: string,
		collectionId: string,
		payload: AddRunToCollectionPayload,
	) {
		return await evaluationApi.addRunToCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			payload,
		);
	}

	async function cancelCollection(workflowId: string, collectionId: string) {
		return await evaluationApi.cancelCollection(rootStore.restApiContext, workflowId, collectionId);
	}

	// --- AI insights ---

	async function fetchInsights(workflowId: string, collectionId: string) {
		return await evaluationApi.getInsights(rootStore.restApiContext, workflowId, collectionId);
	}

	async function generateInsights(
		workflowId: string,
		collectionId: string,
		payload: { forceRegenerate?: boolean } = {},
	) {
		return await evaluationApi.generateInsights(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			payload,
		);
	}

	return {
		isEvaluationEnabled,
		// test runs
		getTestRuns,
		getTestCaseExecutions,
		fetchTestRuns,
		fetchTestRun,
		fetchTestCaseExecutions,
		startTestRun,
		cancelTestRun,
		deleteTestRun,
		// configs
		getConfigs,
		fetchEvaluationConfigs,
		fetchEvaluationConfig,
		createEvaluationConfig,
		updateEvaluationConfig,
		deleteEvaluationConfig,
		// collections
		getCollections,
		fetchCollections,
		fetchCollection,
		createCollection,
		updateCollection,
		deleteCollection,
		addRunToCollection,
		cancelCollection,
		// insights
		fetchInsights,
		generateInsights,
	};
});
