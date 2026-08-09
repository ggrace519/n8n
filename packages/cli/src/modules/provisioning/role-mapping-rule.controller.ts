import {
	CreateRoleMappingRuleDto,
	ListRoleMappingRuleQueryDto,
	MoveRoleMappingRuleDto,
	PatchRoleMappingRuleDto,
} from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	GlobalScope,
	Middleware,
	Param,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import type { NextFunction, Response } from 'express';

import type { RoleMappingRuleResponse } from './role-mapping-rule.service';
import { RoleMappingRuleService } from './role-mapping-rule.service';

/**
 * Mapping-rule CRUD. Provisioning rides on either SSO protocol, so the license
 * gate is "SAML or OIDC" rather than a single feature flag.
 */
@RestController('/role-mapping-rule')
export class RoleMappingRuleController {
	constructor(
		private readonly roleMappingRuleService: RoleMappingRuleService,
		private readonly licenseState: LicenseState,
	) {}

	/**
	 * Provisioning rides on either SSO protocol, so the gate is "SAML or OIDC"
	 * rather than one feature flag — expressed as a middleware so the body stays
	 * a bare message, like the framework's own access gates.
	 */
	@Middleware()
	assertLicensed(_req: AuthenticatedRequest, res: Response, next: NextFunction): void {
		if (!this.licenseState.isProvisioningLicensed()) {
			res.status(403).json({ message: 'Provisioning is not licensed' });
			return;
		}
		next();
	}

	@Get('/')
	@GlobalScope('roleMappingRule:list')
	async list(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListRoleMappingRuleQueryDto,
	): Promise<{ count: number; items: RoleMappingRuleResponse[] }> {
		return await this.roleMappingRuleService.list(query);
	}

	@Post('/')
	@GlobalScope('roleMappingRule:create')
	async create(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: CreateRoleMappingRuleDto,
	): Promise<RoleMappingRuleResponse> {
		return await this.roleMappingRuleService.create(payload, req.user);
	}

	@Patch('/:id')
	@GlobalScope('roleMappingRule:update')
	async patch(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: PatchRoleMappingRuleDto,
	): Promise<RoleMappingRuleResponse> {
		return await this.roleMappingRuleService.patch(id, payload, req.user);
	}

	@Post('/:id/move')
	@GlobalScope('roleMappingRule:update')
	async move(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: MoveRoleMappingRuleDto,
	): Promise<RoleMappingRuleResponse> {
		return await this.roleMappingRuleService.move(id, payload.targetIndex, req.user);
	}

	@Delete('/:id')
	@GlobalScope('roleMappingRule:delete')
	async delete(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
	): Promise<{ success: true }> {
		return await this.roleMappingRuleService.delete(id, req.user);
	}
}
