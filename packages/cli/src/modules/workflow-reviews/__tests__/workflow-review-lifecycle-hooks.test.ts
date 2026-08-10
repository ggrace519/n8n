import type { Logger } from '@n8n/backend-common';
import type { OperationContext, Transaction } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { WorkflowReviewFeatureService } from '../workflow-review-feature.service';
import { WorkflowReviewLifecycleHooks } from '../workflow-review-lifecycle-hooks';
import type { WorkflowReviewService } from '../workflow-review.service';

describe('WorkflowReviewLifecycleHooks', () => {
	const logger = mock<Logger>();
	const featureService = mock<WorkflowReviewFeatureService>();
	const reviewService = mock<WorkflowReviewService>();
	const hooks = new WorkflowReviewLifecycleHooks(logger, featureService, reviewService);

	const transferCtx: OperationContext = { trx: mock<Transaction>() };

	beforeEach(() => {
		vi.clearAllMocks();
		featureService.isAvailable.mockReturnValue(true);
		reviewService.closeOpenReviewsForWorkflows.mockResolvedValue();
		reviewService.removeOrphanedReviews.mockResolvedValue(0);
		reviewService.notifyWorkflowsChanged.mockResolvedValue();
	});

	it('closes reviews when a workflow is archived', async () => {
		await hooks.afterWorkflowArchived('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(['wf-1'], null);
	});

	it("closes reviews inside the transfer's own transaction", async () => {
		await hooks.duringWorkflowsTransferred(['wf-1', 'wf-2'], transferCtx);

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(
			['wf-1', 'wf-2'],
			null,
			transferCtx,
		);
	});

	it('fails the transfer when the reviews cannot be closed', async () => {
		reviewService.closeOpenReviewsForWorkflows.mockRejectedValue(new Error('db down'));

		await expect(hooks.duringWorkflowsTransferred(['wf-1'], transferCtx)).rejects.toThrow(
			'db down',
		);
	});

	it('only broadcasts after a transfer has committed', async () => {
		await hooks.afterWorkflowsTransferred(['wf-1']);

		expect(reviewService.notifyWorkflowsChanged).toHaveBeenCalledWith(['wf-1']);
		expect(reviewService.closeOpenReviewsForWorkflows).not.toHaveBeenCalled();
	});

	it('closes reviews before a workflow is deleted, while the rows still exist', async () => {
		await hooks.beforeWorkflowDeleted('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).toHaveBeenCalledWith(['wf-1'], null);
	});

	it('aborts the deletion when the reviews cannot be closed', async () => {
		reviewService.closeOpenReviewsForWorkflows.mockRejectedValue(new Error('db down'));

		await expect(hooks.beforeWorkflowDeleted('wf-1')).rejects.toThrow('db down');
	});

	it('removes the requests orphaned by the delete cascade afterwards', async () => {
		await hooks.afterWorkflowDeleted('wf-1');

		expect(reviewService.removeOrphanedReviews).toHaveBeenCalled();
	});

	it('is inert when the feature is unavailable', async () => {
		featureService.isAvailable.mockReturnValue(false);

		await hooks.afterWorkflowArchived('wf-1');
		await hooks.beforeWorkflowDeleted('wf-1');
		await hooks.duringWorkflowsTransferred(['wf-1'], transferCtx);
		await hooks.afterWorkflowDeleted('wf-1');

		expect(reviewService.closeOpenReviewsForWorkflows).not.toHaveBeenCalled();
		expect(reviewService.removeOrphanedReviews).not.toHaveBeenCalled();
	});

	it('never throws out of a hook that observes a committed mutation', async () => {
		reviewService.closeOpenReviewsForWorkflows.mockRejectedValue(new Error('db down'));
		reviewService.removeOrphanedReviews.mockRejectedValue(new Error('db down'));
		reviewService.notifyWorkflowsChanged.mockRejectedValue(new Error('push down'));

		await expect(hooks.afterWorkflowArchived('wf-1')).resolves.toBeUndefined();
		await expect(hooks.afterWorkflowDeleted('wf-1')).resolves.toBeUndefined();
		await expect(hooks.afterWorkflowsTransferred(['wf-1'])).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledTimes(3);
	});
});
