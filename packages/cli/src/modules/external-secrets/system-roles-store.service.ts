import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING } from '@n8n/permissions';

/**
 * Reads the `externalSecrets.systemRoles.enabled` instance setting, which
 * decides whether the built-in system roles receive external-secrets scopes.
 *
 * The scope map behind the setting is empty in this fork, so switching it on
 * currently widens nothing — the flag is surfaced so the client can reflect the
 * instance's configuration.
 */
@Service()
export class ExternalSecretsSystemRolesStore {
	constructor(private readonly settingsRepository: SettingsRepository) {}

	async isEnabled(): Promise<boolean> {
		const row = await this.settingsRepository.findByKey(
			EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING.key,
		);
		return row?.value === 'true';
	}
}
