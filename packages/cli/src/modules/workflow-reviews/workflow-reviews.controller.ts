import {
	CreateWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestDto,
	GetWorkflowReviewEligibleReviewersQueryDto,
	ListWorkflowReviewInboxQueryDto,
	ListWorkflowReviewRequestsQueryDto,
	UpdateWorkflowReviewRequestVersionDto,
	type DecideWorkflowReviewRequestResponse,
	type GetWorkflowReviewInboxSummaryResponse,
	type ListWorkflowReviewInboxResponse,
	type WorkflowReviewEligibleReviewersList,
	type WorkflowReviewRequestDetail,
	type WorkflowReviewRequestList,
	type WorkflowReviewRequestSummary,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, Param, Post, Query, RestController } from '@n8n/decorators';

import { WorkflowReviewService } from './workflow-review.service';

/**
 * REST surface for workflow reviews.
 *
 * Route order matters: the static `/eligible-reviewers`, `/summary` and
 * `/inbox` paths are declared before `/:workflowReviewRequestId`, or the
 * parameterised route would swallow them and answer 404.
 *
 * Every handler delegates authorization to {@link WorkflowReviewService}, which
 * checks the feature gate and the caller's workflow scopes. There is no route
 * here that is safe without it.
 */
@RestController('/workflow-review-requests')
export class WorkflowReviewsController {
	constructor(private readonly service: WorkflowReviewService) {}

	/** Workflow-scoped list, newest first. */
	@Get('/')
	async list(
		req: AuthenticatedRequest,
		_res: unknown,
		@Query query: ListWorkflowReviewRequestsQueryDto,
	): Promise<WorkflowReviewRequestList> {
		return await this.service.listForWorkflow(req.user, query);
	}

	@Get('/eligible-reviewers')
	async eligibleReviewers(
		req: AuthenticatedRequest,
		_res: unknown,
		@Query query: GetWorkflowReviewEligibleReviewersQueryDto,
	): Promise<WorkflowReviewEligibleReviewersList> {
		return await this.service.listEligibleReviewers(req.user, query.workflowId);
	}

	@Get('/summary')
	async inboxSummary(req: AuthenticatedRequest): Promise<GetWorkflowReviewInboxSummaryResponse> {
		return await this.service.getInboxSummary(req.user);
	}

	@Get('/inbox')
	async inbox(
		req: AuthenticatedRequest,
		_res: unknown,
		@Query query: ListWorkflowReviewInboxQueryDto,
	): Promise<ListWorkflowReviewInboxResponse> {
		return await this.service.listInbox(req.user, query);
	}

	@Post('/')
	async create(
		req: AuthenticatedRequest,
		_res: unknown,
		@Body dto: CreateWorkflowReviewRequestDto,
	): Promise<WorkflowReviewRequestSummary> {
		return await this.service.create(req.user, dto);
	}

	@Post('/:workflowReviewRequestId/update-version')
	async updateVersion(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('workflowReviewRequestId') workflowReviewRequestId: string,
		@Body dto: UpdateWorkflowReviewRequestVersionDto,
	): Promise<WorkflowReviewRequestSummary> {
		return await this.service.updateVersion(req.user, workflowReviewRequestId, dto);
	}

	@Post('/:workflowReviewRequestId/decision')
	async decide(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('workflowReviewRequestId') workflowReviewRequestId: string,
		@Body dto: DecideWorkflowReviewRequestDto,
	): Promise<DecideWorkflowReviewRequestResponse> {
		return await this.service.decide(req.user, workflowReviewRequestId, dto);
	}

	@Get('/:workflowReviewRequestId')
	async detail(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('workflowReviewRequestId') workflowReviewRequestId: string,
	): Promise<WorkflowReviewRequestDetail> {
		return await this.service.getDetail(req.user, workflowReviewRequestId);
	}
}
