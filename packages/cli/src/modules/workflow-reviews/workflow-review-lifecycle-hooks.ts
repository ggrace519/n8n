import { Logger } from '@n8n/backend-common';
import type { OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import type { WorkflowMutationHooks } from '@/workflows/workflow-mutation-hooks-proxy.service';

import { WorkflowReviewFeatureService } from './workflow-review-feature.service';
import { WorkflowReviewService } from './workflow-review.service';

/**
 * Closes open reviews when the workflow underneath them changes hands or goes
 * away. An open review on an archived, transferred or deleted workflow can never
 * be decided, and would keep blocking publication forever.
 *
 * Which failures may propagate follows what the caller can still undo:
 * `duringWorkflowsTransferred` and `beforeWorkflowDeleted` run while the
 * mutation can be rolled back or called off, so they throw; the `after*` hooks
 * observe a committed mutation and only log.
 */
@Service()
export class WorkflowReviewLifecycleHooks implements WorkflowMutationHooks {
	constructor(
		private readonly logger: Logger,
		private readonly featureService: WorkflowReviewFeatureService,
		private readonly reviewService: WorkflowReviewService,
	) {}

	async afterWorkflowArchived(workflowId: string): Promise<void> {
		await this.closeReviewsBestEffort([workflowId]);
	}

	/**
	 * Closes the reviews in the transfer's own transaction. The review's
	 * `projectId` no longer matches the workflow's owner, so the review is closed
	 * rather than migrated to the destination project — and it must be closed
	 * atomically with the ownership change, because inbox authorization follows
	 * the workflow's current sharing rows: a surviving open review would be
	 * visible to, and decidable by, the destination project's members.
	 */
	async duringWorkflowsTransferred(workflowIds: string[], ctx: OperationContext): Promise<void> {
		if (!this.featureService.isAvailable()) return;

		// Deliberately not caught: failing the transfer is the correct outcome, and
		// the transaction rolls the ownership change back with it.
		await this.reviewService.closeOpenReviewsForWorkflows(workflowIds, null, ctx);
	}

	async afterWorkflowsTransferred(workflowIds: string[]): Promise<void> {
		if (!this.featureService.isAvailable()) return;

		try {
			// The closure already committed with the transfer; this is only the push
			// that tells open editors to refetch.
			await this.reviewService.notifyWorkflowsChanged(workflowIds);
		} catch (error) {
			this.logger.error('Failed to broadcast workflow review state after a transfer', {
				workflowIds,
				message: ensureError(error).message,
			});
		}
	}

	async beforeWorkflowDeleted(workflowId: string): Promise<void> {
		if (!this.featureService.isAvailable()) return;

		// Runs while the rows still exist and the delete can still be called off.
		// A swallowed failure here would delete the workflow while leaving its
		// review open, so the error propagates and aborts the deletion.
		await this.reviewService.closeOpenReviewsForWorkflows([workflowId], null);
	}

	async afterWorkflowDeleted(_workflowId: string): Promise<void> {
		if (!this.featureService.isAvailable()) return;

		try {
			// The delete cascades the child link but not its parent request, which is
			// then unreachable — every read path joins the link table. Swept here
			// rather than removed up front, so a delete that fails part-way does not
			// destroy the review history of a workflow that still exists.
			await this.reviewService.removeOrphanedReviews();
		} catch (error) {
			// Observes a committed delete: nothing left to abort, and the next
			// deletion sweeps whatever this attempt left behind.
			this.logger.error('Failed to remove review requests orphaned by a workflow deletion', {
				message: ensureError(error).message,
			});
		}
	}

	private async closeReviewsBestEffort(workflowIds: string[]): Promise<void> {
		// Availability, not the policy toggle: rows created while the feature was on
		// must still be tidied up if an admin turns the policy off afterwards.
		if (!this.featureService.isAvailable()) return;

		try {
			await this.reviewService.closeOpenReviewsForWorkflows(workflowIds, null);
		} catch (error) {
			// The hook observes a mutation that already happened; throwing here would
			// fail an archive over review bookkeeping.
			this.logger.error('Failed to close open workflow reviews for a lifecycle change', {
				workflowIds,
				message: ensureError(error).message,
			});
		}
	}
}
