import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';

import {
	DEFAULT_SOURCE_CONTROL_PREFERENCES,
	type SourceControlPreferences,
} from './types/source-control-preferences';

const SOURCE_CONTROL_PREFERENCES_DB_KEY = 'features.sourceControl';

/**
 * Owns the instance-wide source-control preferences: an in-memory copy for
 * synchronous reads (branch guards run on hot request paths), persisted to
 * the settings table. Git-side operations (connect, key management, sync)
 * live in the source-control service.
 */
@Service()
export class SourceControlPreferencesService {
	private preferences: SourceControlPreferences = { ...DEFAULT_SOURCE_CONTROL_PREFERENCES };

	private loaded = false;

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly logger: Logger,
	) {}

	getPreferences(): SourceControlPreferences {
		return { ...this.preferences };
	}

	isSourceControlConnected(): boolean {
		return this.preferences.connected;
	}

	/** Whether a repository has been configured (regardless of connection state). */
	isSourceControlSetup(): boolean {
		return (
			this.preferences.connected &&
			this.preferences.repositoryUrl !== '' &&
			this.preferences.branchName !== ''
		);
	}

	async setPreferences(
		preferences: Partial<SourceControlPreferences>,
		saveToDb = true,
	): Promise<SourceControlPreferences> {
		await this.ensureLoaded();
		this.preferences = { ...this.preferences, ...preferences };
		if (saveToDb) {
			// The public key is derived from the key pair at runtime — never persist it.
			const { publicKey, ...toSave } = this.preferences;
			await this.settingsRepository.upsertByKey(
				SOURCE_CONTROL_PREFERENCES_DB_KEY,
				JSON.stringify(toSave),
				false,
				{},
			);
		}
		return this.getPreferences();
	}

	async loadFromDbAndApplySourceControlPreferences(): Promise<SourceControlPreferences> {
		const setting = await this.settingsRepository.findByKey(SOURCE_CONTROL_PREFERENCES_DB_KEY);
		if (setting?.value) {
			try {
				this.preferences = {
					...DEFAULT_SOURCE_CONTROL_PREFERENCES,
					...jsonParse<Partial<SourceControlPreferences>>(setting.value),
				};
			} catch {
				this.logger.warn('Failed to parse stored source-control preferences, using defaults');
			}
		}
		this.loaded = true;
		return this.getPreferences();
	}

	private async ensureLoaded() {
		if (!this.loaded) await this.loadFromDbAndApplySourceControlPreferences();
	}
}
