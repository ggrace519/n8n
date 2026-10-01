import type { LdapConfigurationResponse, UpdateLdapConfigurationDto } from '@n8n/api-types';
import type { LdapConfig } from '@n8n/constants';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

/** The config as sent to clients: the bind password is never returned, only whether one is set. */
export function toLdapConfigurationResponse(config: LdapConfig): LdapConfigurationResponse {
	return {
		...config,
		bindingAdminPassword: config.bindingAdminPassword ? CREDENTIAL_BLANKING_VALUE : '',
	};
}

/** Apply a client update; a still-redacted password means "keep the current one". */
export function toLdapConfigUpdate(
	data: UpdateLdapConfigurationDto,
	current: LdapConfig,
): LdapConfig {
	return {
		...data,
		bindingAdminPassword:
			data.bindingAdminPassword === CREDENTIAL_BLANKING_VALUE
				? current.bindingAdminPassword
				: data.bindingAdminPassword,
	};
}
