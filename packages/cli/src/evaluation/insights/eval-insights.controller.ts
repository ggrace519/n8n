import { GenerateInsightsDto } from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Body, Get, Param, Post, RestController } from '@n8n/decorators';
import type { Scope } from '@n8n/permissions';
import type { Response } from 'express';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EvalInsightsService } from '@/evaluation/insights/eval-insights.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

/**
 * AI insights for one evaluation collection. GET reads the cached envelope
 * (`data: null` when none is cached); POST generates — or returns the cache
 * when fresh and `forceRegenerate` isn't set — and stores the result.
 */
@RestController('/workflows/:workflowId/eval-collections/:collectionId/insights')
export class EvalInsightsController {
	constructor(
		private readonly evalInsightsService: EvalInsightsService,
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
	async getCached(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		return await this.evalInsightsService.getCached(workflowId, collectionId);
	}

	@Post('/')
	async generate(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('collectionId') collectionId: string,
		@Body payload: GenerateInsightsDto,
	) {
		// Generation writes the cache onto the collection row.
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		return await this.evalInsightsService.generate(workflowId, collectionId, payload);
	}
}
