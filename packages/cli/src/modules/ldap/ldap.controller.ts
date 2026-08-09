import { LdapSyncDto, UpdateLdapConfigurationDto } from '@n8n/api-types';
import type { LdapConfig } from '@n8n/constants';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Licensed, Post, Put, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { EventService } from '@/events/event.service';

import { getLdapSynchronizationsWithCount } from './helpers';
import { LdapService } from './ldap.service';

@RestController('/ldap')
export class LdapController {
	constructor(
		private readonly ldapService: LdapService,
		private readonly eventService: EventService,
	) {}

	@Get('/config')
	@Licensed('feat:ldap')
	@GlobalScope('ldap:manage')
	async getConfig() {
		return await this.ldapService.loadConfig();
	}

	@Put('/config')
	@Licensed('feat:ldap')
	@GlobalScope('ldap:manage')
	async updateConfig(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: UpdateLdapConfigurationDto,
	) {
		// The DTO strips unknown properties; the endpoint rejects them.
		const strict = UpdateLdapConfigurationDto.schema.strict().safeParse(req.body);
		if (!strict.success) {
			throw new BadRequestError(strict.error.issues[0]?.message ?? 'Invalid LDAP configuration');
		}
		try {
			const updated = await this.ldapService.updateConfig(payload as unknown as LdapConfig);
			this.eventService.emit('ldap-settings-updated', {
				userId: req.user.id,
				loginIdAttribute: updated.loginIdAttribute,
				firstNameAttribute: updated.firstNameAttribute,
				lastNameAttribute: updated.lastNameAttribute,
				emailAttribute: updated.emailAttribute,
				ldapIdAttribute: updated.ldapIdAttribute,
				searchPageSize: updated.searchPageSize,
				searchTimeout: updated.searchTimeout,
				synchronizationEnabled: updated.synchronizationEnabled,
				synchronizationInterval: updated.synchronizationInterval,
				loginLabel: updated.loginLabel,
				loginEnabled: updated.loginEnabled,
			});
			return updated;
		} catch (error) {
			throw new BadRequestError(error instanceof Error ? error.message : String(error));
		}
	}

	@Post('/test-connection')
	@Licensed('feat:ldap')
	@GlobalScope('ldap:manage')
	async testConnection() {
		try {
			await this.ldapService.testConnection();
		} catch (error) {
			throw new BadRequestError(error instanceof Error ? error.message : String(error));
		}
	}

	@Post('/sync')
	@Licensed('feat:ldap')
	@GlobalScope('ldap:manage')
	async syncLdap(_req: AuthenticatedRequest, _res: Response, @Body payload: LdapSyncDto) {
		return await this.ldapService.runSync(payload.type);
	}

	@Get('/sync')
	@Licensed('feat:ldap')
	@GlobalScope('ldap:manage')
	async getLdapSync(req: AuthenticatedRequest<{}, {}, {}, { page?: string; perPage?: string }>) {
		const perPage = Number(req.query.perPage) || 20;
		const page = Number(req.query.page) || 0;
		const [rows] = await getLdapSynchronizationsWithCount(page * perPage, perPage);
		return rows;
	}
}
