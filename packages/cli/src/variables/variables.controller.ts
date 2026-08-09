import {
	CreateVariableRequestDto,
	UpdateVariableRequestDto,
	VariableListRequestDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	GlobalScope,
	Licensed,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import type { Response } from 'express';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { VariableCountLimitReachedError } from '@/errors/variable-count-limit-reached.error';
import { VariableValidationError } from '@/errors/variable-validation.error';
import { VariablesService } from '@/variables/variables.service';

@RestController('/variables')
export class VariablesController {
	constructor(private readonly variablesService: VariablesService) {}

	@Get('/')
	@GlobalScope('variable:list')
	async getVariables(
		req: AuthenticatedRequest,
		_res: Response,
		@Query payload: VariableListRequestDto,
	) {
		return await this.variablesService.getAllForUser(req.user, payload);
	}

	@Get('/:id')
	@GlobalScope('variable:read')
	async getVariable(req: AuthenticatedRequest<{ id: string }>) {
		// Resolve through the user's visible set so inaccessible project
		// variables read as missing rather than forbidden.
		const variables = await this.variablesService.getAllForUser(req.user);
		const variable = variables.find((v) => v.id === req.params.id);
		if (variable === undefined) {
			throw new NotFoundError(`Variable with ID "${req.params.id}" could not be found`);
		}
		return variable;
	}

	@Post('/')
	@Licensed('feat:variables')
	@GlobalScope('variable:create')
	async createVariable(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: CreateVariableRequestDto,
	) {
		try {
			return await this.variablesService.create(req.user, payload);
		} catch (error) {
			if (
				error instanceof VariableCountLimitReachedError ||
				error instanceof VariableValidationError
			) {
				throw new BadRequestError(error.message);
			}
			throw error;
		}
	}

	@Patch('/:id')
	@Licensed('feat:variables')
	@GlobalScope('variable:update')
	async updateVariable(
		req: AuthenticatedRequest<{ id: string }>,
		_res: Response,
		@Body payload: UpdateVariableRequestDto,
	) {
		try {
			return await this.variablesService.update(req.user, req.params.id, payload);
		} catch (error) {
			if (
				error instanceof VariableCountLimitReachedError ||
				error instanceof VariableValidationError
			) {
				throw new BadRequestError(error.message);
			}
			throw error;
		}
	}

	@Delete('/:id')
	@Licensed('feat:variables')
	@GlobalScope('variable:delete')
	async deleteVariable(req: AuthenticatedRequest<{ id: string }>) {
		await this.variablesService.delete(req.params.id);
		return true;
	}
}
