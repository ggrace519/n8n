import { Service } from '@n8n/di';
import { DataSource, In, IsNull } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { WorkflowReviewRequestWorkflow } from '../entities/workflow-review-request-workflow';
import type { OperationContext } from '../services/transaction';
import { isUniqueConstraintError } from '../utils/is-unique-constraint-error';

export type PinnedWorkflowVersionInput = {
	workflowReviewRequestId: string;
	workflowId: string;
	workflowVersionId: string | null;
};

export type CreateWorkflowReviewRequestWorkflowInput = PinnedWorkflowVersionInput & {
	/**
	 * Whether the parent request is open. Drives the open sentinel, so it has to
	 * be stated rather than assumed: linking a workflow to an already-closed
	 * request must not claim the workflow's single open slot.
	 */
	open: boolean;
};

/**
 * Outcome of linking a workflow to a new review. `open-review-exists` is the
 * unique-constraint rejection on the open sentinel translated into a domain
 * result, so business logic can map it to a conflict without inspecting a
 * driver error.
 */
export type CreateWorkflowRowResult =
	| { status: 'created'; row: WorkflowReviewRequestWorkflow }
	| { status: 'open-review-exists' };

@Service()
export class WorkflowReviewRequestWorkflowRepository extends BaseRepository<WorkflowReviewRequestWorkflow> {
	constructor(dataSource: DataSource) {
		super(WorkflowReviewRequestWorkflow, dataSource.manager);
	}

	/**
	 * Links a workflow to a review, claiming the open sentinel when that review is
	 * open. A concurrent create that already claimed the workflow loses on the
	 * unique constraint and is reported back as a conflict — the check-then-insert
	 * in the caller narrows the race, the constraint closes it.
	 *
	 * The failed statement poisons the surrounding transaction on Postgres, so
	 * callers must abandon it (they raise a conflict, which rolls it back) rather
	 * than continue.
	 */
	async createWorkflowRow(
		input: CreateWorkflowReviewRequestWorkflowInput,
		ctx: OperationContext,
	): Promise<CreateWorkflowRowResult> {
		const manager = this.managerFor(ctx);
		const row = manager.create(WorkflowReviewRequestWorkflow, {
			workflowReviewRequestId: input.workflowReviewRequestId,
			workflowId: input.workflowId,
			workflowVersionId: input.workflowVersionId,
			openWorkflowId: input.open ? input.workflowId : null,
		});

		try {
			return { status: 'created', row: await manager.save(WorkflowReviewRequestWorkflow, row) };
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			return { status: 'open-review-exists' };
		}
	}

	async findByRequestId(
		requestId: string,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequestWorkflow[]> {
		return await this.managerFor(ctx).find(WorkflowReviewRequestWorkflow, {
			where: { workflowReviewRequestId: requestId },
		});
	}

	/**
	 * Repoints the pin of one workflow within a request. Scoped by `workflowId`
	 * too, so a request's other workflow rows can never be touched. Returns the
	 * affected row count so a caller inside a transaction can treat `0` as
	 * "that workflow is not part of this review".
	 */
	async updatePinnedVersion(
		{ workflowReviewRequestId, workflowId, workflowVersionId }: PinnedWorkflowVersionInput,
		ctx: OperationContext,
	): Promise<number> {
		const result = await this.managerFor(ctx).update(
			WorkflowReviewRequestWorkflow,
			{ workflowReviewRequestId, workflowId },
			{ workflowVersionId },
		);
		return result.affected ?? 0;
	}

	/**
	 * Takes the link row for a decision, asserting the pin is still the one the
	 * decision was resolved against, and clears the open sentinel when the
	 * decision closes the request.
	 *
	 * The write re-reads the row under its lock, so a re-pin that commits between
	 * the caller's read and this statement yields `0` rather than letting a
	 * version nobody reviewed be approved. Rewriting the pin to its own value is
	 * deliberate: it is what makes this a locking, condition-checking write.
	 *
	 * Lock order across the module is link row before request row — every path
	 * that touches both (create, re-pin, decide, lifecycle closure) follows it.
	 */
	async takeLinkAtPin(
		{
			workflowReviewRequestId,
			workflowId,
			expectedVersionId,
			clearOpenSentinel,
		}: {
			workflowReviewRequestId: string;
			workflowId: string;
			expectedVersionId: string | null;
			clearOpenSentinel: boolean;
		},
		ctx: OperationContext,
	): Promise<number> {
		const result = await this.managerFor(ctx).update(
			WorkflowReviewRequestWorkflow,
			{
				workflowReviewRequestId,
				workflowId,
				// A pruned version leaves a null pin; equality would never match it and
				// the request could never be decided.
				workflowVersionId: expectedVersionId === null ? IsNull() : expectedVersionId,
			},
			{
				workflowVersionId: expectedVersionId,
				...(clearOpenSentinel ? { openWorkflowId: null } : {}),
			},
		);
		return result.affected ?? 0;
	}

	/** Workflow ids touched by the given requests, for post-commit broadcasts. */
	async findWorkflowIdsByRequestIds(
		requestIds: string[],
		ctx: OperationContext,
	): Promise<string[]> {
		if (requestIds.length === 0) return [];

		const rows = await this.managerFor(ctx).find(WorkflowReviewRequestWorkflow, {
			where: { workflowReviewRequestId: In(requestIds) },
			select: ['workflowId'],
		});
		return [...new Set(rows.map((row) => row.workflowId))];
	}
}
