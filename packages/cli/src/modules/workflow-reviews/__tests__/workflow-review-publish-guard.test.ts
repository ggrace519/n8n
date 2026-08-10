import { mock } from 'vitest-mock-extended';

import { WorkflowPublishBlockedError } from '@/errors/response-errors/workflow-publish-blocked.error';

import type { WorkflowReviewFeatureService } from '../workflow-review-feature.service';
import { WorkflowReviewPublishGuard } from '../workflow-review-publish-guard';
import type { WorkflowReviewService } from '../workflow-review.service';

describe('WorkflowReviewPublishGuard', () => {
	const featureService = mock<WorkflowReviewFeatureService>();
	const reviewService = mock<WorkflowReviewService>();
	const guard = new WorkflowReviewPublishGuard(featureService, reviewService);

	beforeEach(() => {
		vi.clearAllMocks();
		featureService.isEnabled.mockResolvedValue(true);
	});

	it('permits publishing when no review blocks it', async () => {
		reviewService.findBlockingReview.mockResolvedValue(null);

		await expect(guard.assertCanPublish('wf-1')).resolves.toBeUndefined();
	});

	it('blocks a pending review with reason review_pending', async () => {
		reviewService.findBlockingReview.mockResolvedValue({ id: 'rev-1', decision: 'pending' });

		await expect(guard.assertCanPublish('wf-1')).rejects.toThrow(WorkflowPublishBlockedError);
		await expect(guard.assertCanPublish('wf-1')).rejects.toMatchObject({
			details: { reason: 'review_pending', workflowReviewRequestId: 'rev-1' },
		});
	});

	it('blocks a changes-requested review with its own reason', async () => {
		reviewService.findBlockingReview.mockResolvedValue({
			id: 'rev-2',
			decision: 'changes_requested',
		});

		await expect(guard.assertCanPublish('wf-1')).rejects.toMatchObject({
			details: { reason: 'changes_requested', workflowReviewRequestId: 'rev-2' },
		});
	});

	it('does not even look for a review when the feature is disabled', async () => {
		featureService.isEnabled.mockResolvedValue(false);

		await expect(guard.assertCanPublish('wf-1')).resolves.toBeUndefined();
		expect(reviewService.findBlockingReview).not.toHaveBeenCalled();
	});
});
