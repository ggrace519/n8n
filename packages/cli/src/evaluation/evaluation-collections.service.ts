import type {
	AddRunToCollectionPayload,
	CreateEvaluationCollectionPayload,
	EvalCollectionVersionEntry,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
	EvaluationCollectionRunSummary,
	MetricScale,
	UpdateEvaluationCollectionPayload,
} from '@n8n/api-types';
import {
	averageNormalizedScore,
	metricScalesFromConfig,
	metricScalesFromSnapshot,
} from '@n8n/api-types';
import type { EvaluationCollection, TestRun, User } from '@n8n/db';
import {
	EvaluationCollectionRepository,
	EvaluationConfigRepository,
	TestRunRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { ErrorReporter } from 'n8n-core';
import { UserError } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { TestRunnerService } from '@/evaluation/test-runner/test-runner.service';

/**
 * CRUD + run orchestration for evaluation collections — named groups of test
 * runs used to compare workflow versions against each other. Callers are
 * responsible for workflow-level authorization (the controller resolves the
 * workflow through the user's access before calling in).
 */
@Service()
export class EvaluationCollectionsService {
	constructor(
		private readonly evaluationCollectionRepository: EvaluationCollectionRepository,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly testRunRepository: TestRunRepository,
		private readonly testRunnerService: TestRunnerService,
		private readonly errorReporter: ErrorReporter,
	) {}

	async list(workflowId: string): Promise<EvaluationCollectionRecord[]> {
		const rows = await this.evaluationCollectionRepository.findManyByWorkflowId(workflowId);
		return rows.map(({ collection, runCount }) => this.toRecord(collection, runCount));
	}

	async getDetail(workflowId: string, collectionId: string): Promise<EvaluationCollectionDetail> {
		const collection = await this.evaluationCollectionRepository.findOneWithRunsInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');

		// The collection's live config supplies the top-level scales and the
		// fallback for runs whose snapshot carries none. It may have been deleted
		// since (FK is CASCADE on config delete, so normally it exists).
		const config = await this.evaluationConfigRepository.findOneInWorkflow(
			collection.evaluationConfigId,
			workflowId,
		);
		const configScales = config ? metricScalesFromConfig(config.metrics) : undefined;

		const runs = this.sortedRuns(collection);

		return {
			...this.toRecord(collection, runs.length),
			runs: runs.map((run) => this.toRunSummary(run, configScales)),
			...(configScales ? { metricScales: configScales } : {}),
		};
	}

	async create(
		workflowId: string,
		user: User,
		dto: CreateEvaluationCollectionPayload,
	): Promise<EvaluationCollectionRecord> {
		const config = await this.evaluationConfigRepository.findOneInWorkflow(
			dto.evaluationConfigId,
			workflowId,
		);
		if (!config) {
			throw new BadRequestError(
				`Evaluation config ${dto.evaluationConfigId} not found on this workflow`,
			);
		}

		// Validate referenced runs before the collection row exists, so a bad
		// reference fails the request instead of leaving a half-attached group.
		for (const entry of dto.versions) {
			if (
				entry.existingTestRunId &&
				!(await this.testRunRepository.existsInWorkflow(entry.existingTestRunId, workflowId))
			) {
				throw new BadRequestError(`Test run ${entry.existingTestRunId} not found on this workflow`);
			}
		}

		const collection = await this.evaluationCollectionRepository.save(
			this.evaluationCollectionRepository.create({
				name: dto.name,
				description: dto.description ?? null,
				workflowId,
				evaluationConfigId: dto.evaluationConfigId,
				createdById: user.id,
				insightsCache: null,
			}),
		);

		for (const entry of dto.versions) {
			if (entry.existingTestRunId) {
				await this.testRunRepository.update(entry.existingTestRunId, {
					collectionId: collection.id,
				});
				continue;
			}
			const { finished } = await this.startCollectionRun(
				user,
				workflowId,
				collection.id,
				dto,
				entry,
			);
			// Case execution runs detached; route a late rejection to the error
			// reporter instead of leaving it unhandled.
			void finished.catch((error: unknown) => this.errorReporter.error(error));
		}

		return this.toRecord(collection, dto.versions.length);
	}

	async update(
		workflowId: string,
		collectionId: string,
		dto: UpdateEvaluationCollectionPayload,
	): Promise<EvaluationCollectionRecord> {
		const collection = await this.evaluationCollectionRepository.findOneWithRunsInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');

		if (dto.name !== undefined) collection.name = dto.name;
		if (dto.description !== undefined) collection.description = dto.description;
		const saved = await this.evaluationCollectionRepository.save(collection);

		return this.toRecord(saved, collection.testRuns?.length ?? 0);
	}

	async deleteCollection(workflowId: string, collectionId: string): Promise<void> {
		const collection = await this.evaluationCollectionRepository.findOneInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');
		// Runs survive the delete: the FK sets their collectionId to NULL.
		await this.evaluationCollectionRepository.delete({ id: collectionId });
	}

	async addRun(
		workflowId: string,
		collectionId: string,
		dto: AddRunToCollectionPayload,
	): Promise<void> {
		const collection = await this.evaluationCollectionRepository.findOneInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');
		if (!(await this.testRunRepository.existsInWorkflow(dto.testRunId, workflowId))) {
			throw new NotFoundError('Test run not found');
		}

		await this.testRunRepository.update(dto.testRunId, { collectionId });
		// The run set changed; cached insights no longer describe it.
		await this.evaluationCollectionRepository.updateInsightsCache(collectionId, null);
	}

	/**
	 * Cancel every non-terminal run in the collection. Deliberately no
	 * `cancel-collection` pubsub publish: `cancelTestRun` is idempotent and
	 * already persists the per-run cancel flag, aborts locally, and broadcasts
	 * `cancel-test-run` to other mains for runs executing elsewhere — a
	 * collection-level command would only duplicate that per-run fan-out.
	 */
	async cancelCollection(workflowId: string, collectionId: string): Promise<void> {
		const collection = await this.evaluationCollectionRepository.findOneWithRunsInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');

		for (const run of collection.testRuns ?? []) {
			if (run.status === 'new' || run.status === 'running') {
				await this.testRunnerService.cancelTestRun(run.id);
			}
		}
		// Run statuses changed, so any cached insights describe a stale run set.
		await this.evaluationCollectionRepository.updateInsightsCache(collectionId, null);
	}

	private async startCollectionRun(
		user: User,
		workflowId: string,
		collectionId: string,
		dto: CreateEvaluationCollectionPayload,
		entry: EvalCollectionVersionEntry,
	) {
		try {
			return await this.testRunnerService.startTestRun(user, workflowId, dto.concurrency ?? 1, {
				evaluationConfigId: dto.evaluationConfigId,
				compileFromConfig: true,
				collectionId,
				// `workflowVersionId: null` means "current draft": omit it so the
				// runner executes the saved workflow and records its own versionId.
				...(entry.workflowVersionId ? { workflowVersionId: entry.workflowVersionId } : {}),
			});
		} catch (error) {
			// A bad version/config reference is caller input, not a server bug.
			if (error instanceof UserError) throw new BadRequestError(error.message);
			throw error;
		}
	}

	/** Oldest-first, so version labels ("V1", "V2", …) follow run order. */
	private sortedRuns(collection: EvaluationCollection): TestRun[] {
		return [...(collection.testRuns ?? [])].sort(
			(a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
		);
	}

	private toRecord(collection: EvaluationCollection, runCount: number): EvaluationCollectionRecord {
		return {
			id: collection.id,
			name: collection.name,
			description: collection.description,
			workflowId: collection.workflowId,
			evaluationConfigId: collection.evaluationConfigId,
			createdById: collection.createdById,
			createdAt: collection.createdAt.toISOString(),
			updatedAt: collection.updatedAt.toISOString(),
			runCount,
		};
	}

	private toRunSummary(
		run: TestRun,
		configScales?: Record<string, MetricScale>,
	): EvaluationCollectionRunSummary {
		// A run's values were produced against its frozen config snapshot; fall
		// back to the collection's live config only when no snapshot survives.
		const metricScales =
			metricScalesFromSnapshot(run.evaluationConfigSnapshot) ?? configScales ?? {};
		return {
			testRunId: run.id,
			workflowVersionId: run.workflowVersionId,
			status: run.status,
			runAt: run.runAt?.toISOString() ?? null,
			completedAt: run.completedAt?.toISOString() ?? null,
			avgScore: averageNormalizedScore(run.metrics, metricScales),
			metrics: this.toNumericMetrics(run.metrics),
			metricScales,
		};
	}

	private toNumericMetrics(metrics: TestRun['metrics']): Record<string, number> | null {
		if (!metrics) return null;
		const numeric: Record<string, number> = {};
		for (const [key, value] of Object.entries(metrics)) {
			numeric[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
		}
		return numeric;
	}
}
