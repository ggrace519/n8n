import type { LicenseState } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import { WORKFLOW_REVIEWS_ENV_FEATURE_FLAG } from '@/constants/workflow-reviews';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import type { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

import { WorkflowReviewFeatureService } from '../workflow-review-feature.service';

describe('WorkflowReviewFeatureService', () => {
	const licenseState = mock<LicenseState>();
	const policyService = mock<WorkflowReviewPolicyService>();
	const service = new WorkflowReviewFeatureService(licenseState, policyService);

	beforeEach(() => {
		vi.clearAllMocks();
		process.env[WORKFLOW_REVIEWS_ENV_FEATURE_FLAG] = 'true';
		licenseState.isWorkflowReviewsLicensed.mockReturnValue(true);
		policyService.get.mockResolvedValue({ enabled: true });
	});

	afterAll(() => {
		delete process.env[WORKFLOW_REVIEWS_ENV_FEATURE_FLAG];
	});

	describe('isAvailable', () => {
		it('requires both the license and the environment flag', () => {
			expect(service.isAvailable()).toBe(true);

			licenseState.isWorkflowReviewsLicensed.mockReturnValue(false);
			expect(service.isAvailable()).toBe(false);

			licenseState.isWorkflowReviewsLicensed.mockReturnValue(true);
			process.env[WORKFLOW_REVIEWS_ENV_FEATURE_FLAG] = 'TRUE';
			expect(service.isAvailable()).toBe(false);
		});
	});

	describe('isEnabled', () => {
		it('is true only when available and the policy is on', async () => {
			await expect(service.isEnabled()).resolves.toBe(true);

			policyService.get.mockResolvedValue({ enabled: false });
			await expect(service.isEnabled()).resolves.toBe(false);
		});

		it('does not read the policy when the feature is unavailable', async () => {
			licenseState.isWorkflowReviewsLicensed.mockReturnValue(false);

			await expect(service.isEnabled()).resolves.toBe(false);
			expect(policyService.get).not.toHaveBeenCalled();
		});

		it('re-reads the policy on every call so a toggle takes effect immediately', async () => {
			await service.isEnabled();
			await service.isEnabled();

			expect(policyService.get).toHaveBeenCalledTimes(2);
		});
	});

	describe('assertEnabled', () => {
		it('passes when enabled', async () => {
			await expect(service.assertEnabled()).resolves.toBeUndefined();
		});

		it('throws a forbidden error when disabled', async () => {
			policyService.get.mockResolvedValue({ enabled: false });

			await expect(service.assertEnabled()).rejects.toThrow(ForbiddenError);
		});
	});
});
