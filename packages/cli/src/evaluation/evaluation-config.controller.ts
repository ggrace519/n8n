import type { UpsertEvaluationConfigDto } from '@n8n/api-types';
import { EvaluationErrorCode, upsertEvaluationConfigSchema } from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Delete, Get, Param, Patch, Post, RestController } from '@n8n/decorators';
import type { Scope } from '@n8n/permissions';
import type { Response } from 'express';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import {
	EvaluationConfigError,
	EvaluationConfigService,
} from '@/evaluation/evaluation-config.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

@RestController('/workflows/:workflowId/evaluation-configs')
export class EvaluationConfigController {
	constructor(
		private readonly evaluationConfigService: EvaluationConfigService,
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

	/**
	 * The upsert schema is a zod intersection, so it can't be a Z.class DTO
	 * validated by the REST layer — parse the body here instead.
	 */
	private parseBody(body: unknown): UpsertEvaluationConfigDto {
		const result = upsertEvaluationConfigSchema.safeParse(body);
		if (!result.success) {
			const issues = result.error.issues
				.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
				.join('; ');
			throw new BadRequestError(`Invalid evaluation config: ${issues}`);
		}
		return result.data;
	}

	/** Surface service validation failures as 400/404 carrying the typed code. */
	private rethrowMapped(error: unknown): never {
		if (error instanceof EvaluationConfigError) {
			const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
			const message = `${error.code}: ${error.message}${details}`;
			if (error.code === EvaluationErrorCode.CONFIG_NOT_FOUND) throw new NotFoundError(message);
			throw new BadRequestError(message);
		}
		throw error;
	}

	@Get('/')
	async getMany(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		return await this.evaluationConfigService.list(workflowId);
	}

	@Get('/:configId')
	async getOne(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('configId') configId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		const config = await this.evaluationConfigService.get(workflowId, configId);
		if (!config) throw new NotFoundError('Evaluation config not found');
		return config;
	}

	@Post('/')
	async create(req: AuthenticatedRequest, _res: Response, @Param('workflowId') workflowId: string) {
		const workflow = await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		const dto = this.parseBody(req.body);
		try {
			return await this.evaluationConfigService.create(workflowId, workflow, req.user, dto);
		} catch (error) {
			this.rethrowMapped(error);
		}
	}

	@Patch('/:configId')
	async update(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('configId') configId: string,
	) {
		const workflow = await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		const dto = this.parseBody(req.body);
		try {
			return await this.evaluationConfigService.update(
				workflowId,
				configId,
				workflow,
				req.user,
				dto,
			);
		} catch (error) {
			this.rethrowMapped(error);
		}
	}

	@Delete('/:configId')
	async delete(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('configId') configId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		try {
			await this.evaluationConfigService.delete(workflowId, configId);
		} catch (error) {
			this.rethrowMapped(error);
		}
		return { success: true };
	}
}
