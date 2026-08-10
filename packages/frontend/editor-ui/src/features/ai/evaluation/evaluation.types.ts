// Frontend-facing evaluation types.
//
// The schema-derived DTOs that the `@n8n/api-types` package re-exports from its
// root are re-exported here so evaluation callers have a single import surface.
// The internal REST endpoints (test-runs, evaluation-configs, dataset rows)
// return `@n8n/db` entity shapes and their DTO barrel is NOT re-exported from
// the api-types root, so those shapes are mirrored locally — clean-room, from
// the fair-code backend contract, not copied from any licensed source.

export type {
	StartTestRunPayload,
	MetricScale,
	EvalCollectionRunStatus,
	EvaluationCollectionRecord,
	EvaluationCollectionRunSummary,
	EvaluationCollectionDetail,
	EvalCollectionVersionEntry,
	CreateEvaluationCollectionPayload,
	UpdateEvaluationCollectionPayload,
	AddRunToCollectionPayload,
	EvalVersionsResponse,
	EvalVersionEntry,
	AiInsightsResponse,
} from '@n8n/api-types';

// ---------------------------------------------------------------------------
// Test runs (internal REST — returns @n8n/db entities)
// ---------------------------------------------------------------------------

export type TestRunStatus = 'new' | 'running' | 'completed' | 'error' | 'cancelled';

export type TestCaseExecutionStatus =
	| 'new'
	| 'running'
	| 'evaluation_running'
	| 'success'
	| 'error'
	| 'warning'
	| 'cancelled';

export type TestRunFinalResult = 'success' | 'error' | 'warning';

/** Aggregated per-run / per-case metric values, keyed by metric name. */
export type AggregatedTestRunMetrics = Record<string, number | boolean>;

export interface TestRunRecord {
	id: string;
	createdAt: string;
	updatedAt: string;
	workflowId: string;
	status: TestRunStatus;
	errorCode: string | null;
	errorDetails: Record<string, unknown> | null;
	runAt: string | null;
	completedAt: string | null;
	metrics: AggregatedTestRunMetrics | null;
	workflowVersionId: string | null;
	evaluationConfigId: string | null;
	evaluationConfigSnapshot: Record<string, unknown> | null;
	collectionId: string | null;
	finalResult?: TestRunFinalResult | null;
}

export type TestRunSummary = TestRunRecord & {
	finalResult: TestRunFinalResult | null;
	testCaseCount: number;
};

export interface TestCaseExecutionRecord {
	id: string;
	createdAt: string;
	updatedAt: string;
	testRunId: string;
	executionId: string | null;
	status: TestCaseExecutionStatus;
	runAt: string | null;
	completedAt: string | null;
	errorCode: string | null;
	errorDetails: Record<string, unknown> | null;
	metrics: AggregatedTestRunMetrics | null;
	inputs: Record<string, unknown> | null;
	outputs: Record<string, unknown> | null;
	runIndex: number | null;
}

export interface GetTestRunsQuery {
	take?: number;
	skip?: number;
}

/** POST /test-runs/new responds 202 with the created run id, not the run. */
export interface StartTestRunResponse {
	success: true;
	testRunId: string;
}

// ---------------------------------------------------------------------------
// Evaluation config + metrics + dataset reference
// ---------------------------------------------------------------------------

export type MetricOutputType = 'numeric' | 'boolean';

export type EvaluationMetricType =
	| 'expression'
	| 'llm_judge'
	| 'string_similarity'
	| 'categorization'
	| 'tools_used';

export type LlmJudgeMetricPreset = 'correctness' | 'helpfulness';

export interface EvaluationMetric {
	id: string;
	name: string;
	type: EvaluationMetricType;
	config: Record<string, unknown>;
}

export type DatasetSource = 'data_table' | 'google_sheets';

export interface DataTableDatasetRef {
	dataTableId: string;
}

export interface GoogleSheetsDatasetRef {
	credentialId: string;
	spreadsheetId: string;
	sheetName: string;
	headerRow?: number;
}

export type DatasetRef =
	| { datasetSource: 'data_table'; datasetRef: DataTableDatasetRef }
	| { datasetSource: 'google_sheets'; datasetRef: GoogleSheetsDatasetRef };

export type EvaluationConfigStatus = 'valid' | 'invalid';

export type EvaluationConfig = {
	id: string;
	workflowId: string;
	name: string;
	status: EvaluationConfigStatus;
	invalidReason: string | null;
	startNodeName: string;
	endNodeName: string;
	metrics: EvaluationMetric[];
} & DatasetRef;

export type UpsertEvaluationConfigPayload = {
	name: string;
	startNodeName: string;
	endNodeName: string;
	metrics: EvaluationMetric[];
} & DatasetRef;

// ---------------------------------------------------------------------------
// Add-execution-to-dataset (candidate + row insert)
//
// NOTE: the DTOs for these exist in `@n8n/api-types` but are not wired to any
// REST route in this fork yet (see report). The api calls target the intended
// paths so the UI compiles; they will not resolve until the backend lands.
// ---------------------------------------------------------------------------

export type DatasetFieldSource = 'input' | 'output';

export type DatasetColumnMapping = {
	source: DatasetFieldSource;
	field: string;
} | null;

export interface DatasetColumnCandidate {
	name: string;
	type: string;
}

export interface DatasetCandidateField {
	key: string;
	sample: unknown;
}

export interface DatasetCandidateResponse {
	dataTableId: string;
	columns: DatasetColumnCandidate[];
	fields: {
		inputs: DatasetCandidateField[];
		outputs: DatasetCandidateField[];
	};
	suggestedMapping: Record<string, DatasetColumnMapping>;
}

export interface AddDatasetRowPayload {
	executionId: string;
	mapping: Record<string, DatasetColumnMapping>;
}

// ---------------------------------------------------------------------------
// AI insights envelope (cached / generated)
// ---------------------------------------------------------------------------

import type { AiInsightsResponse } from '@n8n/api-types';

export interface AiInsightsEnvelope {
	data: AiInsightsResponse | null;
}
