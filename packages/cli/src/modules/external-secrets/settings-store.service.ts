import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';

import type { ExternalSecretsSettings } from './types';

export const EXTERNAL_SECRETS_SETTINGS_KEY = 'feature.externalSecrets';

/**
 * Reads and writes the legacy single-row provider configuration.
 *
 * The row holds provider credentials, so it is only ever stored encrypted with
 * the instance key — the same `Cipher` the credential subsystem uses. Nothing
 * here logs the decrypted value.
 */
@Service()
export class ExternalSecretsSettingsStore {
	private cached: ExternalSecretsSettings | null = null;

	constructor(
		private readonly logger: Logger,
		private readonly settingsRepository: SettingsRepository,
		private readonly cipher: Cipher,
	) {}

	/** Re-read the row from the database, replacing the cached copy. */
	async reload(): Promise<ExternalSecretsSettings | null> {
		const row = await this.settingsRepository.findByKey(EXTERNAL_SECRETS_SETTINGS_KEY);
		if (row === null) {
			this.cached = null;
			return null;
		}

		try {
			this.cached = JSON.parse(this.cipher.decrypt(row.value)) as ExternalSecretsSettings;
		} catch {
			// A row encrypted with a different instance key is unusable; report the
			// fact without echoing the ciphertext.
			this.logger.error('Could not decrypt external secrets settings');
			this.cached = null;
		}

		return this.cached;
	}

	async save(settings: ExternalSecretsSettings): Promise<ExternalSecretsSettings> {
		await this.settingsRepository.upsertByKey(
			EXTERNAL_SECRETS_SETTINGS_KEY,
			this.cipher.encrypt(settings),
			false,
			{},
		);
		this.cached = settings;
		return settings;
	}

	/** The last loaded settings, without touching the database. */
	getCached(): ExternalSecretsSettings | null {
		return this.cached;
	}
}
