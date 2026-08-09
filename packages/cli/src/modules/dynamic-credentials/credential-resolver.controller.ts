import {
	CreateCredentialResolverDto,
	ListCredentialResolversQueryDto,
	UpdateCredentialResolverDto,
	type CredentialResolverAffectedWorkflow,
	type CredentialResolverType,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	GlobalScope,
	Param,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import type { Response } from 'express';

import type { CredentialResolverResponse } from './services/credential-resolver-crud.service';
import { CredentialResolverCrudService } from './services/credential-resolver-crud.service';

/**
 * Credential-resolver CRUD. Resolvers are instance-wide configuration (they
 * have no owning project), so access is gated on the global
 * `credentialResolver:*` scopes rather than a project role.
 */
@RestController('/credential-resolvers')
export class CredentialResolverController {
	constructor(private readonly crudService: CredentialResolverCrudService) {}

	@Get('/')
	@GlobalScope('credentialResolver:list')
	async list(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListCredentialResolversQueryDto,
	): Promise<CredentialResolverResponse[]> {
		return await this.crudService.list(query.includeSystem ?? false);
	}

	@Get('/types')
	@GlobalScope('credentialResolver:list')
	getTypes(): CredentialResolverType[] {
		return this.crudService.listTypes();
	}

	@Get('/:id')
	@GlobalScope('credentialResolver:read')
	async get(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
	): Promise<CredentialResolverResponse> {
		return await this.crudService.get(id);
	}

	@Get('/:id/workflows')
	@GlobalScope('credentialResolver:read')
	async getAffectedWorkflows(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
	): Promise<CredentialResolverAffectedWorkflow[]> {
		return await this.crudService.findAffectedWorkflows(id);
	}

	@Post('/')
	@GlobalScope('credentialResolver:create')
	async create(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body payload: CreateCredentialResolverDto,
	): Promise<CredentialResolverResponse> {
		return await this.crudService.create(payload);
	}

	@Patch('/:id')
	@GlobalScope('credentialResolver:update')
	async update(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: UpdateCredentialResolverDto,
	): Promise<CredentialResolverResponse> {
		return await this.crudService.update(id, payload);
	}

	@Delete('/:id')
	@GlobalScope('credentialResolver:delete')
	async delete(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
	): Promise<{ success: true }> {
		await this.crudService.delete(id);
		return { success: true };
	}
}
