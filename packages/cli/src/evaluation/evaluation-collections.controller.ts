import {
	AddRunToCollectionDto,
	CreateEvaluationCollectionDto,
	UpdateEvaluationCollectionDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Body, Delete, Get, Param, Patch, Post, RestController } from '@n8n/decorators';
import type { Scope } from '@n8n/permissions';
import type { Response } from 'express';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EvaluationCollectionsService } from '@/evaluation/evaluation-collections.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

@RestController('/workflows/:workflowId/eval-collections')
export class EvaluationCollectionsController {
	constructor(
		private readonly evaluationCollectionsService: EvaluationCollectionsService,
		private readonly workflowFinderService: WorkflowFinderService,
	) {}

	/**
	 * Resolve the workflow through the user's project/sharing access. Missing
	 * workflow and insufficient access both surface as 404 so the route never
	 * confirms a workflow the caller can't see.
	 */
	private async assertWorkflowAccess(user: User, workflowId: string, scopes: Scope[]) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, scopes);
		if (!workflow) throw new NotFoundError('Workflow not found');
		return workflow;
	}

	@Get('/')
	async getMany(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		return await this.evaluationCollectionsService.list(workflowId);
	}

	@Post('/')
	async create(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Body payload: CreateEvaluationCollectionDto,
	) {
		// Creating a collection can start new evaluation runs.
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:execute']);
		return await this.evaluationCollectionsService.create(workflowId, req.user, payload);
	}

	@Get('/:collectionId')
	async getOne(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		return await this.evaluationCollectionsService.getDetail(workflowId, collectionId);
	}

	@Patch('/:collectionId')
	async update(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
		@Body payload: UpdateEvaluationCollectionDto,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		return await this.evaluationCollectionsService.update(workflowId, collectionId, payload);
	}

	@Delete('/:collectionId')
	async delete(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		await this.evaluationCollectionsService.deleteCollection(workflowId, collectionId);
		return { success: true };
	}

	@Post('/:collectionId/runs')
	async addRun(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
		@Body payload: AddRunToCollectionDto,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		await this.evaluationCollectionsService.addRun(workflowId, collectionId, payload);
		return { success: true };
	}

	@Post('/:collectionId/cancel')
	async cancel(
		req: AuthenticatedRequest,
		res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:execute']);
		await this.evaluationCollectionsService.cancelCollection(workflowId, collectionId);
		res.status(202).json({ success: true });
	}
}
