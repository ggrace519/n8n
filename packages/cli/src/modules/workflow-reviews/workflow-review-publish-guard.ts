import { Service } from '@n8n/di';

import { WorkflowPublishBlockedError } from '@/errors/response-errors/workflow-publish-blocked.error';
import type { WorkflowPublishGuard } from '@/workflows/workflow-publish-guard-proxy.service';

import { WorkflowReviewFeatureService } from './workflow-review-feature.service';
import { WorkflowReviewService } from './workflow-review.service';

/**
 * Blocks publishing a workflow while a review of it is still open and
 * undecided. Registered on `WorkflowPublishGuardProxy` so core never depends on
 * this module.
 *
 * The feature state is checked per call, not at registration: turning the policy
 * off must stop enforcement immediately, and it leaves existing review rows
 * intact rather than destroying them.
 */
@Service()
export class WorkflowReviewPublishGuard implements WorkflowPublishGuard {
	constructor(
		private readonly featureService: WorkflowReviewFeatureService,
		private readonly reviewService: WorkflowReviewService,
	) {}

	async assertCanPublish(workflowId: string): Promise<void> {
		if (!(await this.featureService.isEnabled())) return;

		const blocking = await this.reviewService.findBlockingReview(workflowId);
		if (!blocking) return;

		throw new WorkflowPublishBlockedError({
			reason: blocking.decision === 'changes_requested' ? 'changes_requested' : 'review_pending',
			workflowReviewRequestId: blocking.id,
		});
	}
}
