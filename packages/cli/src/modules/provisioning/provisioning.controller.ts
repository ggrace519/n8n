import { ProvisioningConfigPatchDto, type ProvisioningConfigDto } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Patch, RestController } from '@n8n/decorators';

import { ProvisioningService } from './provisioning.service';

/** Read/update the SSO role-provisioning policy. */
@RestController('/sso/provisioning')
export class ProvisioningController {
	constructor(private readonly provisioningService: ProvisioningService) {}

	@Get('/config')
	@GlobalScope('provisioning:manage')
	async getConfig(): Promise<ProvisioningConfigDto> {
		return await this.provisioningService.getProvisioningConfig();
	}

	@Patch('/config')
	@GlobalScope('provisioning:manage')
	async updateConfig(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ProvisioningConfigPatchDto,
	): Promise<ProvisioningConfigDto> {
		return await this.provisioningService.updateProvisioningConfig(payload, req.user);
	}
}
