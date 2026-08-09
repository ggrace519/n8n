import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { TestCaseExecution, TestRun, User } from '@n8n/db';
import {
	EvaluationConfigRepository,
	TestCaseExecutionRepository,
	TestRunErrorCode,
	TestRunRepository,
	WorkflowHistoryRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { OnPubSubEvent } from '@n8n/decorators';
import { ErrorReporter, InstanceSettings } from 'n8n-core';
import type {
	IDataObject,
	INode,
	INodeExecutionData,
	IPinData,
	IRun,
	IWorkflowBase,
	IWorkflowExecutionDataProcess,
} from 'n8n-workflow';
import {
	EVALUATION_NODE_TYPE,
	EVALUATION_TRIGGER_NODE_TYPE,
	ExecutionCancelledError,
	ManualExecutionCancelledError,
	UserError,
	createRunExecutionData,
	deepCopy,
	jsonParse,
} from 'n8n-workflow';
import pLimit from 'p-limit';

import { ActiveExecutions } from '@/active-executions';
import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import { resolveEvaluationConcurrencyLimit } from '@/evaluation/evaluation-concurrency.helper';
import { WorkflowCompilerService } from '@/evaluation/workflow-compiler.service';
import { License } from '@/license';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import { WorkflowRunner } from '@/workflow-runner';

export type StartTestRunOptions = {
	evaluationConfigId?: string;
	compileFromConfig?: boolean;
	rowIndices?: number[];
	via?: 'public-api';
	/** Attach the run to an evaluation collection. */
	collectionId?: string;
	/**
	 * Execute this workflow-history version instead of the saved workflow.
	 * Collections pin each run to a version so compared runs stay comparable.
	 */
	workflowVersionId?: string;
};

/** Hard per-run fan-out cap, matching the start payload's 1–10 clamp. */
const MAX_PER_RUN_CONCURRENCY = 10;

/**
 * Runs a workflow's evaluation: fetches the dataset the Evaluation Trigger
 * points at, executes the workflow once per dataset row (the row pinned onto
 * the trigger), collects per-case metrics from the workflow's Evaluation
 * nodes, and aggregates them onto the run.
 */
@Service()
export class TestRunnerService {
	/** Runs currently executing on this instance, by run id. */
	private readonly runningRuns = new Map<
		string,
		{ abort: AbortController; executionIds: Set<string> }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettings: InstanceSettings,
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowRunner: WorkflowRunner,
		private readonly activeExecutions: ActiveExecutions,
		private readonly concurrencyControl: ConcurrencyControlService,
		private readonly license: License,
		private readonly errorReporter: ErrorReporter,
		private readonly publisher: Publisher,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly workflowCompilerService: WorkflowCompilerService,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
	) {
		this.logger = this.logger.scoped('evaluation');
	}

	/**
	 * Create and start a test run. Resolves with the persisted run and a
	 * detached `finished` promise that settles when every case has; HTTP
	 * callers respond immediately and route `finished` rejections to the
	 * error reporter.
	 */
	async startTestRun(
		user: User,
		workflowId: string,
		concurrency = 1,
		options?: StartTestRunOptions,
	): Promise<{ testRun: TestRun; finished: Promise<void> }> {
		const workflow = await this.workflowRepository.findById(workflowId);
		if (!workflow) throw new UserError(`Workflow ${workflowId} not found`);

		// A version-pinned run executes that history version's graph on top of
		// the saved workflow's identity (id/name/settings stay current).
		let workflowToRun: IWorkflowBase = workflow;
		if (options?.workflowVersionId) {
			const version = await this.workflowHistoryRepository.findOne({
				where: { workflowId, versionId: options.workflowVersionId },
			});
			if (!version) {
				throw new UserError(`Workflow version ${options.workflowVersionId} not found`);
			}
			workflowToRun = {
				...workflow,
				nodes: version.nodes,
				connections: version.connections,
				versionId: version.versionId,
			};
		}

		// Config resolution and compilation happen before the run row exists so
		// a bad request fails the HTTP call instead of leaving an errored run.
		let configSnapshot: IDataObject | undefined;
		if (options?.evaluationConfigId) {
			const config = await this.evaluationConfigRepository.findOneInWorkflow(
				options.evaluationConfigId,
				workflowId,
			);
			if (!config) {
				throw new UserError(`Evaluation config ${options.evaluationConfigId} not found`);
			}
			// Freeze the config the run executes against — results must
			// normalize on these metrics even after the live config changes.
			// Serialized round-trip: a snapshot must not share references with
			// the live entity.
			configSnapshot = jsonParse<IDataObject>(
				JSON.stringify({
					id: config.id,
					name: config.name,
					datasetSource: config.datasetSource,
					datasetRef: config.datasetRef,
					startNodeName: config.startNodeName,
					endNodeName: config.endNodeName,
					metrics: config.metrics,
				}),
			);
			if (options.compileFromConfig) {
				workflowToRun = this.workflowCompilerService.compile(workflowToRun, config);
			}
		}

		const testRun = await this.testRunRepository.createTestRun(workflowId);
		if (options?.evaluationConfigId ?? options?.collectionId) {
			await this.testRunRepository.update(testRun.id, {
				...(options.evaluationConfigId
					? {
							evaluationConfigId: options.evaluationConfigId,
							evaluationConfigSnapshot: configSnapshot ?? null,
						}
					: {}),
				...(options.collectionId ? { collectionId: options.collectionId } : {}),
			});
		}

		const finished = this.executeTestRun({
			testRunId: testRun.id,
			workflowData: workflowToRun,
			user,
			concurrency,
			options,
		});

		return { testRun, finished };
	}

	/**
	 * NOTE the inverted semantics, preserved from the public contract: returns
	 * `true` when the run is in a terminal state and can NOT be cancelled.
	 */
	canBeCancelled(testRun: TestRun): boolean {
		return testRun.status !== 'running' && testRun.status !== 'new';
	}

	/**
	 * Cancel a run wherever it executes: persist the cancellation flag (the
	 * running loop polls it), abort locally when this instance runs it, and
	 * broadcast to the other mains otherwise. A run no instance ever picked
	 * up is settled directly.
	 */
	async cancelTestRun(testRunId: string): Promise<void> {
		await this.testRunRepository.requestCancellation(testRunId);

		const local = this.runningRuns.get(testRunId);
		if (local) {
			this.abortRun(testRunId, local);
			return;
		}

		if (this.instanceSettings.isMultiMain) {
			await this.publisher.publishCommand({
				command: 'cancel-test-run',
				payload: { testRunId },
			});
		}

		// Nothing is running it here; if no instance claimed it either, the
		// polling loop that would observe the flag doesn't exist — settle it.
		const testRun = await this.testRunRepository.findOneBy({ id: testRunId });
		if (
			testRun &&
			!this.canBeCancelled(testRun) &&
			(!testRun.runningInstanceId || testRun.runningInstanceId === this.instanceSettings.hostId)
		) {
			await this.markRunCancelled(testRunId);
		}
	}

	@OnPubSubEvent('cancel-test-run', { instanceType: 'main' })
	handleCancelTestRunCommand({ testRunId }: { testRunId: string }) {
		const local = this.runningRuns.get(testRunId);
		if (local) this.abortRun(testRunId, local);
	}

	private abortRun(
		testRunId: string,
		entry: { abort: AbortController; executionIds: Set<string> },
	) {
		entry.abort.abort();
		// Stop in-flight executions so cancellation is prompt, not
		// best-effort-after-the-case-finishes.
		for (const executionId of entry.executionIds) {
			this.activeExecutions.stopExecution(
				executionId,
				new ManualExecutionCancelledError(executionId),
			);
		}
	}

	private async markRunCancelled(testRunId: string, metrics: TestRun['metrics'] = null) {
		await this.testCaseExecutionRepository.markAllPendingAsCancelled(testRunId);
		await this.testRunRepository.markAsCancelled(testRunId);
		if (metrics) await this.testRunRepository.update(testRunId, { metrics });
	}

	/**
	 * The detached run body. Never throws for run-level failures — those mark
	 * the run errored so `finished` observers always find a settled run.
	 */
	private async executeTestRun(ctx: {
		testRunId: string;
		workflowData: IWorkflowBase;
		user: User;
		concurrency: number;
		options?: StartTestRunOptions;
	}): Promise<void> {
		const { testRunId, workflowData, user, options } = ctx;
		const runEntry = { abort: new AbortController(), executionIds: new Set<string>() };
		this.runningRuns.set(testRunId, runEntry);

		try {
			const trigger = workflowData.nodes.find((node) => node.type === EVALUATION_TRIGGER_NODE_TYPE);
			if (!trigger) {
				await this.failRun(testRunId, TestRunErrorCode.EVALUATION_TRIGGER_NOT_FOUND);
				return;
			}
			if (trigger.disabled) {
				await this.failRun(testRunId, TestRunErrorCode.EVALUATION_TRIGGER_DISABLED);
				return;
			}

			await this.testRunRepository.markAsRunning(testRunId);
			await this.testRunRepository.setRunningInstance(testRunId, this.instanceSettings.hostId);
			// The saved workflow JSON is what runs; record its version for
			// auditability (history rows may be pruned later — no FK).
			if (workflowData.versionId) {
				await this.testRunRepository.setWorkflowVersion(testRunId, workflowData.versionId);
			}
			// Recorded for traceability even without compilation (the saved
			// workflow runs as-is).
			if (options?.evaluationConfigId) {
				await this.testRunRepository.update(testRunId, {
					evaluationConfigId: options.evaluationConfigId,
				});
			}

			// Fetch the dataset up front through the trigger's own `getRows`
			// custom operation — same node, same parameters, so the runner can
			// never disagree with the trigger about what the dataset is.
			let rows: INodeExecutionData[];
			try {
				rows = await this.fetchDatasetRows(workflowData, trigger, user, runEntry);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.failRun(testRunId, TestRunErrorCode.CANT_FETCH_TEST_CASES, { message });
				return;
			}

			// Partial runs: keep the original dataset index as runIndex so
			// results map back onto the dataset. Invalid indices are dropped.
			let selected = rows.map((row, index) => ({ row, index }));
			if (options?.rowIndices?.length) {
				const wanted = new Set(options.rowIndices);
				selected = selected.filter(({ index }) => wanted.has(index));
			}

			if (selected.length === 0) {
				await this.failRun(testRunId, TestRunErrorCode.TEST_CASES_NOT_FOUND);
				return;
			}

			const resolvedLimit = resolveEvaluationConcurrencyLimit(
				this.globalConfig.executions,
				this.license,
			);
			const perRunCap = Math.max(1, Math.min(ctx.concurrency, MAX_PER_RUN_CONCURRENCY));
			const limit = pLimit(resolvedLimit > 0 ? Math.min(resolvedLimit, perRunCap) : perRunCap);

			let cancelObserved = false;
			const shouldStop = async (): Promise<boolean> => {
				if (runEntry.abort.signal.aborted) return true;
				if (!(await this.testRunRepository.isCancellationRequested(testRunId))) return false;
				cancelObserved = true;
				runEntry.abort.abort();
				return true;
			};

			const caseMetrics: Array<Record<string, number | boolean>> = [];
			let failedCases = 0;

			const settlements = await Promise.allSettled(
				selected.map(
					async ({ row, index }) =>
						await limit(async () => {
							if (await shouldStop()) return;

							const caseExecution = await this.testCaseExecutionRepository.createTestCase({
								testRunId,
								runIndex: index,
							});

							// The runner owns the shared evaluation-queue reservation:
							// ActiveExecutions deliberately skips reserving for
							// evaluation mode (nested reservation deadlocks a full
							// queue), so acquire before launching and release after.
							const throttleId = `evaluation:${testRunId}-case-${index}`;
							await this.concurrencyControl.throttle({
								mode: 'evaluation',
								executionId: throttleId,
							});
							try {
								if (await shouldStop()) {
									await this.testCaseExecutionRepository.markAsCancelled(caseExecution.id);
									return;
								}
								const result = await this.runCase({
									workflowData,
									trigger,
									row,
									user,
									runEntry,
									caseExecution,
								});
								if (result?.metrics) caseMetrics.push(result.metrics);
								if (result?.failed) failedCases++;
							} finally {
								this.concurrencyControl.release({ mode: 'evaluation' });
							}
						}),
				),
			);

			const dispatchFailures = settlements
				.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
				.map((s) => (s.reason instanceof Error ? s.reason.message : String(s.reason)));
			if (dispatchFailures.length > 0) {
				this.logger.error(`${dispatchFailures.length} failure(s) outside case execution`, {
					testRunId,
					errors: dispatchFailures,
				});
			}

			// A cancel that landed after the last case settled is still a cancel.
			let wasCancelled = cancelObserved || runEntry.abort.signal.aborted;
			if (!wasCancelled) {
				try {
					wasCancelled = await this.testRunRepository.isCancellationRequested(testRunId);
				} catch (error) {
					dispatchFailures.push(error instanceof Error ? error.message : String(error));
				}
			}

			const aggregated = this.aggregateMetrics(caseMetrics);

			if (wasCancelled) {
				await this.markRunCancelled(testRunId, aggregated);
			} else if (dispatchFailures.length > 0) {
				await this.testRunRepository.markAsError(testRunId, TestRunErrorCode.UNKNOWN_ERROR, {
					message: `${dispatchFailures.length} failure(s) occurred outside case execution.`,
					errors: dispatchFailures,
				});
			} else if (!(await this.testRunRepository.markAsCompleted(testRunId, aggregated))) {
				// A cancel slipped in between the last check and completion —
				// honor it: the 202 the caller already received must hold.
				await this.markRunCancelled(testRunId, aggregated);
			}
			this.logger.debug('Test run settled', { testRunId, wasCancelled, failedCases });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.errorReporter.error(error);
			await this.failRun(testRunId, TestRunErrorCode.UNKNOWN_ERROR, { message });
		} finally {
			this.runningRuns.delete(testRunId);
			await this.testRunRepository.setRunningInstance(testRunId, null).catch(() => {});
		}
	}

	/**
	 * Execute one dataset row: pin the row onto the trigger (evaluation-mode
	 * executions honor pin data), run the whole workflow, then read metrics /
	 * inputs / outputs back off the Evaluation nodes' task data.
	 */
	private async runCase(ctx: {
		workflowData: IWorkflowBase;
		trigger: INode;
		row: INodeExecutionData;
		user: User;
		runEntry: { abort: AbortController; executionIds: Set<string> };
		caseExecution: TestCaseExecution;
	}): Promise<{ metrics?: Record<string, number | boolean>; failed?: boolean } | undefined> {
		const { workflowData, trigger, row, user, runEntry, caseExecution } = ctx;
		const caseId = caseExecution.id;

		try {
			const pinData: IPinData = { [trigger.name]: [row] };
			const runData: IWorkflowExecutionDataProcess = {
				executionMode: 'evaluation',
				workflowData,
				pinData,
				userId: user.id,
				// Force the injected/canvas evaluation trigger as the entry point;
				// without this the engine may pick another trigger on the canvas
				// and the pinned row would never be emitted.
				triggerToStartFrom: { name: trigger.name },
			};
			this.serializeForQueueMode(runData);

			const executionId = await this.workflowRunner.run(runData);
			runEntry.executionIds.add(executionId);
			await this.testCaseExecutionRepository.markAsRunning(caseId, executionId);

			let execution: IRun | undefined;
			try {
				execution = await this.activeExecutions.getPostExecutePromise(executionId);
			} finally {
				runEntry.executionIds.delete(executionId);
			}

			if (runEntry.abort.signal.aborted) {
				await this.testCaseExecutionRepository.markAsCancelled(caseId);
				return undefined;
			}

			if (!execution || execution.data.resultData.error) {
				if (execution?.data.resultData.error instanceof ExecutionCancelledError) {
					await this.testCaseExecutionRepository.markAsCancelled(caseId);
					return undefined;
				}
				await this.testCaseExecutionRepository.markAsError(caseId, 'FAILED_TO_EXECUTE_WORKFLOW', {
					message: execution?.data.resultData.error?.message ?? 'The execution produced no result',
				});
				return { failed: true };
			}

			const metrics = this.collectNodeOutput(workflowData, execution, 'setMetrics');
			const inputs = this.collectNodeOutput(workflowData, execution, 'setInputs');
			const outputs = this.collectNodeOutput(workflowData, execution, 'setOutputs');

			const numericMetrics = this.toMetricRecord(metrics);
			if (!numericMetrics || Object.keys(numericMetrics).length === 0) {
				await this.testCaseExecutionRepository.markAsError(caseId, 'NO_METRICS_COLLECTED', {
					message: 'The workflow finished without setting any metrics.',
				});
				return { failed: true };
			}

			await this.testCaseExecutionRepository.markAsCompleted(caseId, {
				metrics: numericMetrics,
				inputs: inputs ?? null,
				outputs: outputs ?? null,
			});
			return { metrics: numericMetrics };
		} catch (error) {
			// A cancelled execution is a stop, not a case failure.
			if (error instanceof ExecutionCancelledError || runEntry.abort.signal.aborted) {
				await this.testCaseExecutionRepository.markAsCancelled(caseId).catch(() => {});
				return undefined;
			}
			const message = error instanceof Error ? error.message : String(error);
			// Self-contained: one broken case must not fail the whole run.
			try {
				await this.testCaseExecutionRepository.markAsError(caseId, 'UNKNOWN_ERROR', { message });
			} catch {
				this.logger.error('Could not record test case failure', { caseId, message });
			}
			return { failed: true };
		}
	}

	/**
	 * Fetch the full dataset through the trigger's `dataset.getRows` custom
	 * operation, executed as a single-node evaluation run of the same trigger
	 * node (`forceCustomOperation` routes the engine to `getRows` instead of
	 * the node's iterating `execute`).
	 */
	private async fetchDatasetRows(
		workflowData: IWorkflowBase,
		trigger: INode,
		user: User,
		runEntry: { abort: AbortController; executionIds: Set<string> },
	): Promise<INodeExecutionData[]> {
		const fetchWorkflow = deepCopy(workflowData);
		const fetchTrigger = fetchWorkflow.nodes.find((node) => node.name === trigger.name);
		if (!fetchTrigger) throw new UserError('Evaluation trigger disappeared from the workflow');
		fetchTrigger.forceCustomOperation = { resource: 'dataset', operation: 'getRows' };

		const runData: IWorkflowExecutionDataProcess = {
			executionMode: 'evaluation',
			workflowData: fetchWorkflow,
			destinationNode: { nodeName: trigger.name, mode: 'inclusive' },
			userId: user.id,
			triggerToStartFrom: { name: trigger.name },
		};
		this.serializeForQueueMode(runData);

		const executionId = await this.workflowRunner.run(runData);
		// Tracked so a cancel can stop a hung dataset fetch too.
		runEntry.executionIds.add(executionId);
		const execution = await this.activeExecutions
			.getPostExecutePromise(executionId)
			.finally(() => runEntry.executionIds.delete(executionId));
		if (!execution) throw new UserError('Dataset fetch produced no result');
		if (execution.data.resultData.error) {
			throw new UserError(execution.data.resultData.error.message);
		}

		const taskData = execution.data.resultData.runData[trigger.name];
		const items = taskData?.[taskData.length - 1]?.data?.main?.[0];
		return items ?? [];
	}

	/**
	 * Output of the workflow's Evaluation node(s) for one operation, merged in
	 * node order. `setMetrics` emits its values as regular item json;
	 * `setInputs`/`setOutputs` pass the workflow item through untouched and
	 * attach the collected values as `evaluationData` on the FIRST item only
	 * (pinned by the node's own comment). Returns undefined when no such node
	 * ran.
	 */
	private collectNodeOutput(
		workflowData: IWorkflowBase,
		execution: IRun,
		operation: 'setMetrics' | 'setInputs' | 'setOutputs',
	): IDataObject | undefined {
		const nodeNames = workflowData.nodes
			.filter(
				(node) =>
					node.type === EVALUATION_NODE_TYPE &&
					!node.disabled &&
					(node.parameters.operation ?? 'setOutputs') === operation,
			)
			.map((node) => node.name);
		if (nodeNames.length === 0) return undefined;

		let merged: IDataObject | undefined;
		for (const name of nodeNames) {
			const taskData = execution.data.resultData.runData[name];
			const items = taskData?.[taskData.length - 1]?.data?.main?.[0];
			if (!items?.length) continue;
			if (operation === 'setMetrics') {
				for (const item of items) {
					merged = { ...(merged ?? {}), ...item.json };
				}
			} else {
				const evaluationData = items[0].evaluationData;
				if (evaluationData) merged = { ...(merged ?? {}), ...evaluationData };
			}
		}
		return merged;
	}

	/** Keep only the primitive metric values a metrics record may carry. */
	private toMetricRecord(data: IDataObject | undefined): Record<string, number | boolean> | null {
		if (!data) return null;
		const record: Record<string, number | boolean> = {};
		for (const [key, value] of Object.entries(data)) {
			if (typeof value === 'number' || typeof value === 'boolean') record[key] = value;
		}
		return record;
	}

	/**
	 * Aggregate per-case metrics onto the run: numeric values average, booleans
	 * aggregate as the fraction of cases where they were true.
	 */
	private aggregateMetrics(
		caseMetrics: Array<Record<string, number | boolean>>,
	): Record<string, number> | null {
		if (caseMetrics.length === 0) return null;
		const sums = new Map<string, { total: number; count: number }>();
		for (const metrics of caseMetrics) {
			for (const [key, value] of Object.entries(metrics)) {
				const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
				if (typeof numeric !== 'number' || Number.isNaN(numeric)) continue;
				const entry = sums.get(key) ?? { total: 0, count: 0 };
				entry.total += numeric;
				entry.count += 1;
				sums.set(key, entry);
			}
		}
		if (sums.size === 0) return null;
		const aggregated: Record<string, number> = {};
		for (const [key, { total, count }] of sums) {
			aggregated[key] = total / count;
		}
		return aggregated;
	}

	/**
	 * Queue mode persists only `executionData` for workers — the transient
	 * pinData/trigger/destination fields would be lost. Serialize them the
	 * same way offloaded manual executions do so a worker can reconstruct the
	 * evaluation run.
	 */
	private serializeForQueueMode(runData: IWorkflowExecutionDataProcess) {
		if (this.globalConfig.executions.mode !== 'queue') return;
		runData.executionData = createRunExecutionData({
			startData: {
				destinationNode: runData.destinationNode,
			},
			resultData: {
				pinData: runData.pinData,
				runData: null,
			},
			manualData: {
				userId: runData.userId,
				triggerToStartFrom: runData.triggerToStartFrom,
			},
			executionData: null,
		});
	}

	private async failRun(
		testRunId: string,
		errorCode: TestRun['errorCode'],
		errorDetails?: IDataObject,
	) {
		try {
			await this.testCaseExecutionRepository.markAllPendingAsCancelled(testRunId);
			await this.testRunRepository.markAsError(testRunId, errorCode, errorDetails ?? null);
		} catch (error) {
			this.logger.error('Could not record test run failure', {
				testRunId,
				error: error instanceof Error ? error.message : String(error),
			});
			// Rethrow so the detached `finished` promise rejects and the error
			// reporter sees a run that could not be settled.
			throw error;
		}
	}
}
