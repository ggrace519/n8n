import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { TestRun, type TestRunStatus } from '../entities';
import type { TestCaseExecution } from '../entities';
import type { TestRunFinalResult } from '../entities/types-db';
import { BaseRepository } from './base-repository';

// The spread in `toSummary` keeps only data properties, so the mixin methods
// (`generateId`, `setUpdateDate`) are omitted alongside the relation.
export type TestRunSummary = Omit<
	TestRun,
	'testCaseExecutions' | 'generateId' | 'setUpdateDate'
> & {
	finalResult: TestRunFinalResult | null;
	testCaseCount: number;
};

/**
 * Overall outcome of a completed run, derived from its per-case statuses:
 * any errored case makes the run an error, any warning a warning, else
 * success. Runs that aren't completed have no final result.
 */
function deriveFinalResult(
	status: TestRunStatus,
	testCaseExecutions: TestCaseExecution[] | undefined,
): TestRunFinalResult | null {
	if (status !== 'completed' || !testCaseExecutions) return null;
	if (testCaseExecutions.some((c) => c.status === 'error')) return 'error';
	if (testCaseExecutions.some((c) => c.status === 'warning')) return 'warning';
	return 'success';
}

@Service()
export class TestRunRepository extends BaseRepository<TestRun> {
	constructor(dataSource: DataSource) {
		super(TestRun, dataSource.manager);
	}

	async createTestRun(workflowId: string): Promise<TestRun> {
		const testRun = this.create({ workflow: { id: workflowId }, status: 'new' });
		return await this.save(testRun);
	}

	async markAsRunning(id: string) {
		return await this.update(id, { status: 'running', runAt: new Date() });
	}

	async markAsCompleted(id: string, metrics: TestRun['metrics'] = null) {
		return await this.update(id, { status: 'completed', completedAt: new Date(), metrics });
	}

	async markAsCancelled(id: string) {
		return await this.update(id, { status: 'cancelled', completedAt: new Date() });
	}

	async markAsError(
		id: string,
		errorCode: TestRun['errorCode'],
		errorDetails?: TestRun['errorDetails'],
	) {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails: errorDetails ?? null,
		});
	}

	/** Flag a run for cancellation from another main instance (multi-main). */
	async requestCancellation(id: string) {
		return await this.update(id, { cancelRequested: true });
	}

	async setRunningInstance(id: string, runningInstanceId: string | null) {
		return await this.update(id, { runningInstanceId });
	}

	async setWorkflowVersion(id: string, workflowVersionId: string | null) {
		return await this.update(id, { workflowVersionId });
	}

	/**
	 * Newest-first page of a workflow's runs as summaries (per-case relation
	 * replaced by `testCaseCount` + derived `finalResult`).
	 */
	async getMany(
		workflowId: string,
		options: { skip?: number; take?: number } = {},
		status?: TestRunStatus,
	): Promise<TestRunSummary[]> {
		const runs = await this.find({
			where: { workflow: { id: workflowId }, ...(status ? { status } : {}) },
			order: { createdAt: 'DESC' },
			skip: options.skip,
			take: options.take,
			relations: { testCaseExecutions: true },
		});
		return runs.map((run) => this.toSummary(run));
	}

	async countByWorkflowId(workflowId: string, status?: TestRunStatus): Promise<number> {
		return await this.count({
			where: { workflow: { id: workflowId }, ...(status ? { status } : {}) },
		});
	}

	/**
	 * A single run scoped to its workflow — a run id from another workflow
	 * resolves to null so callers can 404 without leaking existence. The
	 * per-case relation stays loaded (callers derive counts from it).
	 */
	async getTestRunSummaryByWorkflowId(
		id: string,
		workflowId: string,
	): Promise<(TestRun & { finalResult: TestRunFinalResult | null }) | null> {
		const run = await this.findOne({
			where: { id, workflow: { id: workflowId } },
			relations: { testCaseExecutions: true },
		});
		if (!run) return null;
		// Own property, not a getter: callers spread the summary, which would
		// drop anything on the prototype.
		run.finalResult = deriveFinalResult(run.status, run.testCaseExecutions);
		return run as TestRun & { finalResult: TestRunFinalResult | null };
	}

	/** Relation-free existence check, scoped to the workflow. */
	async existsInWorkflow(id: string, workflowId: string): Promise<boolean> {
		return await this.exists({ where: { id, workflow: { id: workflowId } } });
	}

	private toSummary(run: TestRun): TestRunSummary {
		const { testCaseExecutions, ...rest } = run;
		return {
			...rest,
			finalResult: deriveFinalResult(run.status, testCaseExecutions),
			testCaseCount: testCaseExecutions?.length ?? 0,
		};
	}
}
