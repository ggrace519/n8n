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
	GlobalScope,
	Param,
	Patch,
	Post,
	RestController,
} from '@n8n/decorators';
import type { Response } from 'express';

import { SecretProvidersConnectionsService } from './secret-providers-connections.service';
import type {
	SecretProviderConnectionListItemResponse,
	SecretProviderConnectionResponse,
} from './secret-providers-connections.service';

/** Instance-wide connection administration. */
@RestController('/secret-providers/connections')
export class SecretProvidersConnectionsController {
	constructor(private readonly connectionsService: SecretProvidersConnectionsService) {}

	@Post('/')
	@GlobalScope('externalSecretsProvider:create')
	async create(
		req: AuthenticatedRequest,
		_res: Response,
		@Body dto: CreateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.create(req.user, dto);
	}

	@Get('/')
	@GlobalScope('externalSecretsProvider:list')
	async list(): Promise<SecretProviderConnectionListItemResponse[]> {
		return await this.connectionsService.list();
	}

	@Get('/:providerKey')
	@GlobalScope('externalSecretsProvider:read')
	async get(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.get(providerKey);
	}

	@Patch('/:providerKey')
	@GlobalScope('externalSecretsProvider:update')
	async update(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') providerKey: string,
		@Body dto: UpdateSecretsProviderConnectionDto,
	): Promise<SecretProviderConnectionResponse> {
		return await this.connectionsService.update(req.user, providerKey, dto);
	}

	@Delete('/:providerKey')
	@GlobalScope('externalSecretsProvider:delete')
	async delete(
		req: AuthenticatedRequest,
		res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<void> {
		await this.connectionsService.delete(req.user, providerKey);
		res.status(204).send();
	}

	@Post('/:providerKey/reload')
	@GlobalScope('externalSecretsProvider:sync')
	async reload(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<{ success: boolean }> {
		return await this.connectionsService.reload(req.user, providerKey);
	}

	@Post('/:providerKey/test')
	@GlobalScope('externalSecretsProvider:sync')
	async test(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') providerKey: string,
	): Promise<TestSecretProviderConnectionResponse> {
		return await this.connectionsService.test(req.user, providerKey);
	}
}
