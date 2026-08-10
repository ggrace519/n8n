import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import type { WorkflowReviewFeatureService } from '../workflow-review-feature.service';
import { WorkflowReviewLifecycleHooks } from '../workflow-review-lifecycle-hooks';
import type { WorkflowReviewService } from '../workflow-review.service';

describe('WorkflowReviewLifecycleHooks', () => {
	const logger = mock<Logger>();
	const featureService = mock<WorkflowReviewFeatureService>();
	const reviewService = mock<WorkflowReviewService>();
	const hooks = new WorkflowReviewLifecycleHooks(logger, featureService, reviewService);

	beforeEach(() => {
		vi.clearAllMocks();
		featureService.isAvailable.mockReturnValue(true);
		reviewService.closeOpenReviewsForWorkflows.mockResolvedValue();
	});

	it('closes reviews when a workflow is archived', async () => {
		await hooks.afterWorkflowArchived('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(['wf-1'], null);
	});

	it('closes reviews for every transferred workflow', async () => {
		await hooks.afterWorkflowsTransferred(['wf-1', 'wf-2']);

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(['wf-1', 'wf-2'], null);
	});

	it('closes reviews before a workflow is deleted, while the rows still exist', async () => {
		await hooks.beforeWorkflowDeleted('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(['wf-1'], null);
	});

	it('does nothing after deletion, since the rows cascaded away', async () => {
		await hooks.afterWorkflowDeleted('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).not.toHaveBeenCalled();
	});

	it('is inert when the feature is unavailable', async () => {
		featureService.isAvailable.mockReturnValue(false);

		await hooks.afterWorkflowArchived('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).not.toHaveBeenCalled();
	});

	it('never throws out of a hook, so it cannot fail the mutation it observes', async () => {
		reviewService.closeOpenReviewsForWorkflows.mockRejectedValue(new Error('db down'));

		await expect(hooks.afterWorkflowArchived('wf-1')).resolves.toBeUndefined();
		await expect(hooks.beforeWorkflowDeleted('wf-1')).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledTimes(2);
	});
});
