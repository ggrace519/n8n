import type { TestSecretProviderConnectionResponse } from '@n8n/api-types';
import {
	CreateSecretsProviderConnectionDto,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	ProjectScope,
	RestController,
} from '@n8n/decorators';
import type { Response } from 'express';

import { SecretProvidersConnectionsService } from './secret-providers-connections.service';
import type {
	SecretProviderConnectionListItemResponse,
	SecretProviderConnectionResponse,
} from './secret-providers-connections.service';

/**
 * Connection administration from inside a project.
 *
 * Reads see the project's own connections plus the global ones; writes only
 * ever reach connections the project owns, so a project cannot reconfigure a
 * connection shared with it or one belonging to somebody else.
 */
@RestController('/secret-providers/projects')
export class SecretProvidersProjectController {
	constructor(private readonly connectionsService: SecretProvidersConnectionsService) {}

	@Get('/:projectId/connections')
	@ProjectScope('externalSecretsProvider:list')
	async list(
		req: AuthenticatedRequest<{ projectId: string }>,
	): Promise<SecretProviderConnectionListItemResponse[]> {
		return await this.connectionsService.listForProject(req.params.projectId);
	}

	@Post('/:projectId/connections')
	@ProjectScope('externalSecretsProvider:create')
	async create(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Body dto: CreateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.create(req.user, dto, {
			projectId: req.params.projectId,
		});
	}

	@Get('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:read')
	async get(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.getForProject(req.params.projectId, providerKey, {
			mustOwn: false,
		});
	}

	@Patch('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:update')
	async update(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('providerKey') providerKey: string,
		@Body dto: UpdateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.update(req.user, providerKey, dto, {
			projectId: req.params.projectId,
		});
	}

	@Delete('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:delete')
	async delete(
		req: AuthenticatedRequest<{ projectId: string }>,
		res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<void> {
		await this.connectionsService.delete(req.user, providerKey, {
			projectId: req.params.projectId,
		});
		res.status(204).send();
	}

	@Post('/:projectId/connections/:providerKey/test')
	@ProjectScope('externalSecretsProvider:sync')
	async test(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<TestSecretProviderConnectionResponse> {
		return await this.connectionsService.test(req.user, providerKey, {
			projectId: req.params.projectId,
		});
	}
}
