import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Workflow reviews: a workflow's owner pins a version for review, a reviewer
 * with publish rights approves or requests changes, and publishing is blocked
 * until they do.
 *
 * No `licenseFlag` here on purpose. The module registers the publish guard and
 * the lifecycle hooks unconditionally, and each of them re-reads the effective
 * feature state (license + `N8N_ENV_FEAT_WORKFLOW_REVIEWS` + the persisted
 * `security.workflowReviews` policy) per call. That way an admin toggling the
 * policy takes effect on the next request instead of the next restart, and
 * previously opened reviews keep their data when the feature is switched off.
 *
 * Entities live in `@n8n/db` (they carry FKs to core tables and are truncated by
 * name in core integration tests), so there is nothing to register in
 * `entities()`.
 */
@BackendModule({ name: 'workflow-reviews' })
export class WorkflowReviewsModule implements ModuleInterface {
	async init() {
		await import('./workflow-reviews.controller.js');

		const { WorkflowPublishGuardProxy } = await import(
			'@/workflows/workflow-publish-guard-proxy.service.js'
		);
		const { WorkflowMutationHooksProxy } = await import(
			'@/workflows/workflow-mutation-hooks-proxy.service.js'
		);
		const { WorkflowReviewPublishGuard } = await import('./workflow-review-publish-guard.js');
		const { WorkflowReviewLifecycleHooks } = await import('./workflow-review-lifecycle-hooks.js');

		Container.get(WorkflowPublishGuardProxy).registerProvider(
			Container.get(WorkflowReviewPublishGuard),
		);
		Container.get(WorkflowMutationHooksProxy).registerProvider(
			Container.get(WorkflowReviewLifecycleHooks),
		);
	}
}
