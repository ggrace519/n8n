import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { WorkflowReviewRequestWorkflow } from '../entities/workflow-review-request-workflow';
import type { OperationContext } from '../services/transaction';

export type CreateWorkflowReviewRequestWorkflowInput = {
	workflowReviewRequestId: string;
	workflowId: string;
	workflowVersionId: string | null;
};

@Service()
export class WorkflowReviewRequestWorkflowRepository extends BaseRepository<WorkflowReviewRequestWorkflow> {
	constructor(dataSource: DataSource) {
		super(WorkflowReviewRequestWorkflow, dataSource.manager);
	}

	async createWorkflowRow(
		input: CreateWorkflowReviewRequestWorkflowInput,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequestWorkflow> {
		const manager = this.managerFor(ctx);
		const row = manager.create(WorkflowReviewRequestWorkflow, {
			workflowReviewRequestId: input.workflowReviewRequestId,
			workflowId: input.workflowId,
			workflowVersionId: input.workflowVersionId,
		});
		return await manager.save(WorkflowReviewRequestWorkflow, row);
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
		{
			workflowReviewRequestId,
			workflowId,
			workflowVersionId,
		}: CreateWorkflowReviewRequestWorkflowInput,
		ctx: OperationContext,
	): Promise<number> {
		const result = await this.managerFor(ctx).update(
			WorkflowReviewRequestWorkflow,
			{ workflowReviewRequestId, workflowId },
			{ workflowVersionId },
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
