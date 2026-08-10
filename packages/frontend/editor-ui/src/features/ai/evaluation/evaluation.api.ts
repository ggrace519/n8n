import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import type {
	AddRunToCollectionPayload,
	CreateEvaluationCollectionPayload,
	UpdateEvaluationCollectionPayload,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
} from '@n8n/api-types';

import type {
	AddDatasetRowPayload,
	AiInsightsEnvelope,
	AiInsightsResponse,
	DatasetCandidateResponse,
	EvaluationConfig,
	GetTestRunsQuery,
	StartTestRunPayload,
	StartTestRunResponse,
	TestCaseExecutionRecord,
	TestRunRecord,
	TestRunSummary,
	UpsertEvaluationConfigPayload,
} from './evaluation.types';

const workflowRoot = (workflowId: string) => `/workflows/${workflowId}`;

// ---------------------------------------------------------------------------
// Test runs — E13 backend (live)
// ---------------------------------------------------------------------------

export const getTestRuns = async (
	context: IRestApiContext,
	workflowId: string,
	query: GetTestRunsQuery = {},
): Promise<TestRunSummary[]> => {
	const params: Record<string, string> = {};
	if (query.take !== undefined) params.take = String(query.take);
	if (query.skip !== undefined) params.skip = String(query.skip);
	return await makeRestApiRequest(context, 'GET', `${workflowRoot(workflowId)}/test-runs`, params);
};

export const getTestRun = async (
	context: IRestApiContext,
	workflowId: string,
	testRunId: string,
): Promise<TestRunRecord> =>
	await makeRestApiRequest(context, 'GET', `${workflowRoot(workflowId)}/test-runs/${testRunId}`);

export const getTestCaseExecutions = async (
	context: IRestApiContext,
	workflowId: string,
	testRunId: string,
): Promise<TestCaseExecutionRecord[]> =>
	await makeRestApiRequest(
		context,
		'GET',
		`${workflowRoot(workflowId)}/test-runs/${testRunId}/test-cases`,
	);

export const deleteTestRun = async (
	context: IRestApiContext,
	workflowId: string,
	testRunId: string,
): Promise<{ success: true }> =>
	await makeRestApiRequest(context, 'DELETE', `${workflowRoot(workflowId)}/test-runs/${testRunId}`);

export const cancelTestRun = async (
	context: IRestApiContext,
	workflowId: string,
	testRunId: string,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/test-runs/${testRunId}/cancel`,
	);

// The create route is literally POST `/test-runs/new` and responds 202 with
// `{ success, testRunId }` — not the run object.
export const startTestRun = async (
	context: IRestApiContext,
	workflowId: string,
	payload: StartTestRunPayload = {},
): Promise<StartTestRunResponse> =>
	await makeRestApiRequest(context, 'POST', `${workflowRoot(workflowId)}/test-runs/new`, payload);

// ---------------------------------------------------------------------------
// Evaluation configs — E13 backend (live)
// ---------------------------------------------------------------------------

export const getEvaluationConfigs = async (
	context: IRestApiContext,
	workflowId: string,
): Promise<EvaluationConfig[]> =>
	await makeRestApiRequest(context, 'GET', `${workflowRoot(workflowId)}/evaluation-configs`);

export const getEvaluationConfig = async (
	context: IRestApiContext,
	workflowId: string,
	configId: string,
): Promise<EvaluationConfig> =>
	await makeRestApiRequest(
		context,
		'GET',
		`${workflowRoot(workflowId)}/evaluation-configs/${configId}`,
	);

export const createEvaluationConfig = async (
	context: IRestApiContext,
	workflowId: string,
	payload: UpsertEvaluationConfigPayload,
): Promise<EvaluationConfig> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/evaluation-configs`,
		payload,
	);

export const updateEvaluationConfig = async (
	context: IRestApiContext,
	workflowId: string,
	configId: string,
	payload: UpsertEvaluationConfigPayload,
): Promise<EvaluationConfig> =>
	await makeRestApiRequest(
		context,
		'PATCH',
		`${workflowRoot(workflowId)}/evaluation-configs/${configId}`,
		payload,
	);

export const deleteEvaluationConfig = async (
	context: IRestApiContext,
	workflowId: string,
	configId: string,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'DELETE',
		`${workflowRoot(workflowId)}/evaluation-configs/${configId}`,
	);

// ---------------------------------------------------------------------------
// Evaluation collections — E13 backend (live)
// ---------------------------------------------------------------------------

export const getCollections = async (
	context: IRestApiContext,
	workflowId: string,
): Promise<EvaluationCollectionRecord[]> =>
	await makeRestApiRequest(context, 'GET', `${workflowRoot(workflowId)}/eval-collections`);

export const getCollection = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
): Promise<EvaluationCollectionDetail> =>
	await makeRestApiRequest(
		context,
		'GET',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}`,
	);

export const createCollection = async (
	context: IRestApiContext,
	workflowId: string,
	payload: CreateEvaluationCollectionPayload,
): Promise<EvaluationCollectionRecord> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/eval-collections`,
		payload,
	);

export const updateCollection = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	payload: UpdateEvaluationCollectionPayload,
): Promise<EvaluationCollectionRecord> =>
	await makeRestApiRequest(
		context,
		'PATCH',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}`,
		payload,
	);

export const deleteCollection = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'DELETE',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}`,
	);

export const addRunToCollection = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	payload: AddRunToCollectionPayload,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}/runs`,
		payload,
	);

export const cancelCollection = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}/cancel`,
	);

// ---------------------------------------------------------------------------
// AI insights — E13 backend (live)
// ---------------------------------------------------------------------------

export const getInsights = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
): Promise<AiInsightsEnvelope> =>
	await makeRestApiRequest(
		context,
		'GET',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}/insights`,
	);

export const generateInsights = async (
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	payload: { forceRegenerate?: boolean } = {},
): Promise<AiInsightsResponse> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/eval-collections/${collectionId}/insights`,
		payload,
	);

// ---------------------------------------------------------------------------
// Add execution to dataset (candidate + row insert)
//
// PENDING: no REST route serves these in this fork yet — the DTOs exist in
// api-types but are unrouted. Paths below reflect the intended contract so the
// modal compiles and is ready to light up when the backend lands.
// ---------------------------------------------------------------------------

export const getDatasetCandidate = async (
	context: IRestApiContext,
	workflowId: string,
	executionId: string,
): Promise<DatasetCandidateResponse> =>
	await makeRestApiRequest(context, 'GET', `${workflowRoot(workflowId)}/datasets/candidate`, {
		executionId,
	});

export const addDatasetRow = async (
	context: IRestApiContext,
	workflowId: string,
	dataTableId: string,
	payload: AddDatasetRowPayload,
): Promise<{ success: true }> =>
	await makeRestApiRequest(
		context,
		'POST',
		`${workflowRoot(workflowId)}/datasets/${dataTableId}/rows`,
		payload,
	);
