import type { CreateWorkflowReviewRequestDto } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import type {
	OperationContext,
	Project,
	SharedWorkflowRepository,
	TransactionRunner,
	User,
	WorkflowEntity,
	WorkflowHistoryRepository,
	WorkflowPublishedVersionRepository,
	WorkflowPublishHistoryRepository,
	WorkflowRepository,
	WorkflowReviewRequest,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestWorkflow,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { CollaborationService } from '@/collaboration/collaboration.service';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { WorkflowService } from '@/workflows/workflow.service';

import type { WorkflowReviewAccessService } from '../workflow-review-access.service';
import type { WorkflowReviewFeatureService } from '../workflow-review-feature.service';
import { WorkflowReviewService } from '../workflow-review.service';

/**
 * Covers the write-path guards that cannot be reached through the API, because
 * an earlier check answers first: the metadata update finding no version, and
 * the conditional writes reporting that the row moved under them.
 */
describe('WorkflowReviewService write guards', () => {
	const logger = mock<Logger>();
	const featureService = mock<WorkflowReviewFeatureService>();
	const accessService = mock<WorkflowReviewAccessService>();
	const requestRepository = mock<WorkflowReviewRequestRepository>();
	const linkRepository = mock<WorkflowReviewRequestWorkflowRepository>();
	const workflowRepository = mock<WorkflowRepository>();
	const workflowHistoryRepository = mock<WorkflowHistoryRepository>();
	const publishHistoryRepository = mock<WorkflowPublishHistoryRepository>();
	const publishedVersionRepository = mock<WorkflowPublishedVersionRepository>();
	const sharedWorkflowRepository = mock<SharedWorkflowRepository>();
	const transactionRunner = mock<TransactionRunner>();
	const collaborationService = mock<CollaborationService>();
	const workflowService = mock<WorkflowService>();

	const service = new WorkflowReviewService(
		logger,
		featureService,
		accessService,
		requestRepository,
		linkRepository,
		workflowRepository,
		workflowHistoryRepository,
		publishHistoryRepository,
		publishedVersionRepository,
		sharedWorkflowRepository,
		transactionRunner,
		collaborationService,
		workflowService,
	);

	const author = mock<User>({ id: 'user-author' });
	const reviewer = mock<User>({ id: 'user-reviewer' });
	const workflowId = 'wf-1';
	const versionId = 'ver-1';

	const openRequest = (overrides: Partial<WorkflowReviewRequest> = {}) =>
		mock<WorkflowReviewRequest>({
			id: 'req-1',
			state: 'open',
			decision: 'pending',
			createdById: author.id,
			authors: [],
			reviewers: [],
			workflows: [
				mock<WorkflowReviewRequestWorkflow>({ workflowId, workflowVersionId: versionId }),
			],
			createdAt: new Date(),
			updatedAt: new Date(),
			...overrides,
		});

	const createDto: CreateWorkflowReviewRequestDto = {
		title: 'Please review',
		workflows: [{ workflowId, workflowVersionId: versionId, workflowVersionName: 'v1' }],
	} as CreateWorkflowReviewRequestDto;

	beforeEach(() => {
		vi.clearAllMocks();

		transactionRunner.run.mockImplementation(
			async <T>(ctx: OperationContext, fn: (ctx: OperationContext) => Promise<T>) => await fn(ctx),
		);
		accessService.findWorkflowWithScopes.mockResolvedValue(
			mock<WorkflowEntity>({ id: workflowId }),
		);
		accessService.canReadWorkflow.mockResolvedValue(true);
		accessService.canPublishWorkflow.mockResolvedValue(true);
		sharedWorkflowRepository.getWorkflowOwningProject.mockResolvedValue(
			mock<Project>({ id: 'proj-1' }),
		);
		workflowHistoryRepository.versionBelongsToWorkflow.mockResolvedValue(true);
		workflowHistoryRepository.updateVersionMetadata.mockResolvedValue(1);
		requestRepository.findOpenRequestForWorkflow.mockResolvedValue(null);
		requestRepository.createRequest.mockResolvedValue(openRequest());
		requestRepository.findRequestWithRelations.mockResolvedValue(openRequest());
		linkRepository.createWorkflowRow.mockResolvedValue({
			status: 'created',
			row: mock<WorkflowReviewRequestWorkflow>({ workflowId, workflowVersionId: versionId }),
		});
		linkRepository.findByRequestId.mockResolvedValue([
			mock<WorkflowReviewRequestWorkflow>({ workflowId, workflowVersionId: versionId }),
		]);
		linkRepository.takeLinkAtPin.mockResolvedValue(1);
		requestRepository.applyDecisionIfOpen.mockResolvedValue(1);
	});

	describe('create', () => {
		it('fails when the version vanished between the pair check and naming it', async () => {
			workflowHistoryRepository.updateVersionMetadata.mockResolvedValue(0);

			await expect(service.create(author, createDto)).rejects.toThrow(NotFoundError);
		});

		it('tolerates a driver that does not report an affected count', async () => {
			workflowHistoryRepository.updateVersionMetadata.mockResolvedValue(undefined);

			await expect(service.create(author, createDto)).resolves.toBeDefined();
		});

		it('conflicts when the open sentinel was already claimed', async () => {
			linkRepository.createWorkflowRow.mockResolvedValue({ status: 'open-review-exists' });

			await expect(service.create(author, createDto)).rejects.toThrow(ConflictError);
		});
	});

	describe('decide', () => {
		it('conflicts and does not publish when the pin moved under the transaction', async () => {
			linkRepository.takeLinkAtPin.mockResolvedValue(0);

			await expect(service.decide(reviewer, 'req-1', { decision: 'approved' })).rejects.toThrow(
				ConflictError,
			);

			expect(requestRepository.applyDecisionIfOpen).not.toHaveBeenCalled();
			expect(workflowService.activateWorkflow).not.toHaveBeenCalled();
		});

		it('conflicts when the reviewer named a version the request no longer pins', async () => {
			await expect(
				service.decide(reviewer, 'req-1', { decision: 'approved', expectedVersionId: 'ver-old' }),
			).rejects.toThrow(ConflictError);

			expect(linkRepository.takeLinkAtPin).not.toHaveBeenCalled();
			expect(workflowService.activateWorkflow).not.toHaveBeenCalled();
		});

		it('releases the open sentinel on approval but keeps it on a change request', async () => {
			await service.decide(reviewer, 'req-1', { decision: 'approved' });
			expect(linkRepository.takeLinkAtPin).toHaveBeenCalledWith(
				expect.objectContaining({ clearOpenSentinel: true, expectedVersionId: versionId }),
				expect.anything(),
			);

			await service.decide(reviewer, 'req-1', { decision: 'changes_requested' });
			expect(linkRepository.takeLinkAtPin).toHaveBeenLastCalledWith(
				expect.objectContaining({ clearOpenSentinel: false }),
				expect.anything(),
			);
		});
	});
});
