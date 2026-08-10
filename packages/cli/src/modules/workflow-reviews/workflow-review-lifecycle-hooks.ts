import { Logger } from '@n8n/backend-common';
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
 * The `after*` hooks observe a committed mutation and must not throw — there is
 * nothing left to abort — so failures are swallowed by the caller's contract and
 * logged by the service instead.
 */
@Service()
export class WorkflowReviewLifecycleHooks implements WorkflowMutationHooks {
	constructor(
		private readonly logger: Logger,
		private readonly featureService: WorkflowReviewFeatureService,
		private readonly reviewService: WorkflowReviewService,
	) {}

	async afterWorkflowArchived(workflowId: string): Promise<void> {
		await this.closeReviews([workflowId]);
	}

	async afterWorkflowsTransferred(workflowIds: string[]): Promise<void> {
		// The review's `projectId` no longer matches the workflow's owner, so the
		// review is closed rather than migrated to the destination project.
		await this.closeReviews(workflowIds);
	}

	async beforeWorkflowDeleted(workflowId: string): Promise<void> {
		// Runs while the rows still exist: the reviews are closed (and broadcast)
		// here, because after the delete cascades there is nothing left to find.
		await this.closeReviews([workflowId]);
	}

	async afterWorkflowDeleted(_workflowId: string): Promise<void> {
		// Review rows are removed by the workflow FK cascade; nothing to clean up.
	}

	private async closeReviews(workflowIds: string[]): Promise<void> {
		// Availability, not the policy toggle: rows created while the feature was on
		// must still be tidied up if an admin turns the policy off afterwards.
		if (!this.featureService.isAvailable()) return;

		try {
			await this.reviewService.closeOpenReviewsForWorkflows(workflowIds, null);
		} catch (error) {
			// The hooks observe mutations that already happened; throwing here would
			// fail an archive or block a delete over review bookkeeping.
			this.logger.error('Failed to close open workflow reviews for a lifecycle change', {
				workflowIds,
				message: ensureError(error).message,
			});
		}
	}
}
