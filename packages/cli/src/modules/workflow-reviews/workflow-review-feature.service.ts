import { LicenseState } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { isWorkflowReviewsFeatureAvailable } from '@/constants/workflow-reviews';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

/**
 * Effective state of the workflow-reviews feature, in two independent layers:
 *
 * - *available* — the instance is licensed **and** the environment flag is set.
 *   Nothing about reviews exists for the user until this holds.
 * - *enabled* — available **and** the persisted `security.workflowReviews`
 *   policy is on. This is what actually gates the REST surface and the publish
 *   guard.
 *
 * The policy is re-read on every call rather than snapshotted: an admin can turn
 * reviews off mid-session and the next request must honour that.
 */
@Service()
export class WorkflowReviewFeatureService {
	constructor(
		private readonly licenseState: LicenseState,
		private readonly policyService: WorkflowReviewPolicyService,
	) {}

	isAvailable(): boolean {
		return isWorkflowReviewsFeatureAvailable(this.licenseState.isWorkflowReviewsLicensed());
	}

	async isEnabled(): Promise<boolean> {
		if (!this.isAvailable()) return false;
		return (await this.policyService.get()).enabled;
	}

	/**
	 * Throws `403` when reviews are off. The frontend treats `403`/`404` on
	 * review reads as "feature went away" and falls back to local state, so this
	 * is a supported response rather than an error path.
	 */
	async assertEnabled(): Promise<void> {
		if (!(await this.isEnabled())) {
			throw new ForbiddenError('Workflow reviews are not enabled on this instance');
		}
	}
}
