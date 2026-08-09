import { ProvisioningConfigDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';

import { PROVISIONING_PREFERENCES_DB_KEY } from './constants';

/**
 * SSO role provisioning state. Reads the persisted `ProvisioningConfigDto`
 * row (written by the instance-settings loader / config endpoint); a missing
 * or partial row silently falls back to disabled defaults.
 */
@Service()
export class ProvisioningService {
	private cachedConfig: ProvisioningConfigDto | null = null;

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly globalConfig: GlobalConfig,
		private readonly logger: Logger,
	) {}

	async getProvisioningConfig(): Promise<ProvisioningConfigDto> {
		if (this.cachedConfig) return this.cachedConfig;

		const disabledDefaults: ProvisioningConfigDto = {
			scopesProvisionInstanceRole: false,
			scopesProvisionProjectRoles: false,
			scopesUseExpressionMapping: false,
			scopesName: this.globalConfig.sso.provisioning.scopesName,
			scopesInstanceRoleClaimName: this.globalConfig.sso.provisioning.scopesInstanceRoleClaimName,
			scopesProjectsRolesClaimName: this.globalConfig.sso.provisioning.scopesProjectsRolesClaimName,
		};

		const row = await this.settingsRepository.findByKey(PROVISIONING_PREFERENCES_DB_KEY);
		if (!row?.value) {
			this.cachedConfig = disabledDefaults;
			return this.cachedConfig;
		}

		try {
			const parsed = ProvisioningConfigDto.safeParse(jsonParse<Record<string, unknown>>(row.value));
			// A partial/invalid row must not half-enable provisioning.
			this.cachedConfig = parsed.success ? parsed.data : disabledDefaults;
		} catch {
			this.logger.warn('Failed to parse stored SSO provisioning config, using disabled defaults');
			this.cachedConfig = disabledDefaults;
		}
		return this.cachedConfig;
	}

	/** Drop the cached config so the next read reflects the stored row. */
	async handleReloadSsoProvisioningConfiguration(): Promise<void> {
		this.cachedConfig = null;
		await this.getProvisioningConfig();
	}

	/** Whether users' instance (global) roles are managed by SSO provisioning. */
	async isInstanceRoleManaged(): Promise<boolean> {
		return (await this.getProvisioningConfig()).scopesProvisionInstanceRole;
	}

	/** Whether project memberships/roles are managed by SSO provisioning. */
	async isProjectRoleManaged(): Promise<boolean> {
		return (await this.getProvisioningConfig()).scopesProvisionProjectRoles;
	}
}
