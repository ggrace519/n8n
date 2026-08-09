import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { LdapConfig } from '@n8n/constants';
import { LDAP_DEFAULT_CONFIGURATION, LDAP_FEATURE_NAME } from '@n8n/constants';
import type { AuthProviderSyncHistory, RunningMode } from '@n8n/db';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { Entry as LdapUserEntry } from 'ldapts';
import { Client } from 'ldapts';
import { Cipher } from 'n8n-core';
import { jsonParse, UnexpectedError } from 'n8n-workflow';

import { EventService } from '@/events/event.service';
import {
	assertAuthenticationMethodCanBeEnabled,
	getCurrentAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from '@/sso/sso-helpers';

import {
	deleteAllLdapIdentities,
	getLdapIdentities,
	createLdapMember,
	disableLdapMembers,
	isValidEmail,
	mapLdapUser,
	saveLdapSynchronization,
	updateLdapMember,
	type MappedLdapUser,
} from './helpers';
import { LdapConnectionError } from './ldap.errors';

/**
 * LDAP single sign-on: configuration lifecycle (persisted as a
 * load-on-startup settings row under `features.ldap`), directory access via
 * `ldapts`, dry/live user synchronization with run history, and the login
 * credential check used by the LDAP auth handler.
 */
@Service()
export class LdapService {
	private config: LdapConfig = { ...LDAP_DEFAULT_CONFIGURATION };

	private syncTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly settingsRepository: SettingsRepository,
		private readonly globalConfig: GlobalConfig,
		private readonly cipher: Cipher,
		private readonly eventService: EventService,
	) {
		this.logger = this.logger.scoped('ldap');
	}

	/** Load config from the settings row, apply runtime mirrors, and start scheduled sync. */
	async init(): Promise<void> {
		await this.loadConfig();
		this.applyRuntimeMirrors();
		this.scheduleSync();
	}

	setConfig(config: LdapConfig): void {
		this.config = config;
		this.applyRuntimeMirrors();
		this.scheduleSync();
	}

	async loadConfig(): Promise<LdapConfig> {
		const row = await this.settingsRepository.findByKey(LDAP_FEATURE_NAME);
		if (row?.value) {
			this.config = {
				...LDAP_DEFAULT_CONFIGURATION,
				...jsonParse<Partial<LdapConfig>>(row.value, { fallbackValue: {} }),
			};
		}
		return this.config;
	}

	getConfig(): LdapConfig {
		return this.config;
	}

	async updateConfig(newConfig: LdapConfig): Promise<LdapConfig> {
		if (newConfig.loginEnabled) {
			assertAuthenticationMethodCanBeEnabled('ldap');
		}

		// Encrypt a newly-supplied admin password; keep the stored (already
		// encrypted) one when the caller did not change it.
		if (
			newConfig.bindingAdminPassword &&
			newConfig.bindingAdminPassword !== this.config.bindingAdminPassword
		) {
			newConfig.bindingAdminPassword = this.cipher.encrypt(newConfig.bindingAdminPassword);
		}

		const wasLoginEnabled = this.config.loginEnabled;
		this.config = { ...newConfig };

		await this.settingsRepository.upsertByKey(
			LDAP_FEATURE_NAME,
			JSON.stringify(this.config),
			true,
			{},
		);

		this.applyRuntimeMirrors();
		this.scheduleSync();

		if (this.config.loginEnabled) {
			await setCurrentAuthenticationMethod('ldap');
		} else if (wasLoginEnabled || getCurrentAuthenticationMethod() === 'ldap') {
			// "Convert all LDAP users to email users": identities are dropped,
			// the accounts stay and log in with email again.
			await deleteAllLdapIdentities();
			await setCurrentAuthenticationMethod('email');
		}

		return this.config;
	}

	/** Verify the configured server and admin credentials are usable. */
	async testConnection(): Promise<void> {
		const client = this.createClient();
		try {
			await this.bindAdmin(client);
		} finally {
			await client.unbind().catch(() => {});
		}
	}

	/** All directory entries matching the configured base DN / user filter. */
	async searchWithAdminBinding(filter: string): Promise<LdapUserEntry[]> {
		const client = this.createClient();
		try {
			await this.bindAdmin(client);
			const { searchEntries } = await client.search(this.config.baseDn, {
				scope: 'sub',
				filter,
				...(this.config.searchPageSize > 0
					? { paged: { pageSize: this.config.searchPageSize } }
					: {}),
				timeLimit: this.config.searchTimeout,
			});
			return searchEntries;
		} finally {
			await client.unbind().catch(() => {});
		}
	}

	/** Credential check for LDAP login: bind as the user's own DN. */
	async validUser(dn: string, password: string): Promise<void> {
		const client = this.createClient();
		try {
			await client.bind(dn, password);
		} finally {
			await client.unbind().catch(() => {});
		}
	}

	/** The search filter matching one user by login ID (escaped). */
	buildLoginFilter(loginId: string): string {
		const escaped = escapeLdapFilterValue(loginId);
		const base = `(${this.config.loginIdAttribute}=${escaped})`;
		return this.config.userFilter ? `(&${this.config.userFilter}${base})` : base;
	}

	/** The search filter matching every synchronizable user. */
	private buildSyncFilter(): string {
		const base = `(${this.config.ldapIdAttribute}=*)`;
		return this.config.userFilter ? `(&${this.config.userFilter}${base})` : base;
	}

	/**
	 * Synchronize the directory with local users. `dry` only computes and
	 * records the would-be changes; `live` applies them: unseen entries become
	 * global members (with personal project + LDAP identity), known entries
	 * update their mapped fields, and local LDAP users missing from the
	 * directory are disabled and unlinked.
	 */
	async runSync(mode: RunningMode): Promise<AuthProviderSyncHistory> {
		this.logger.debug(`LDAP sync started (${mode})`);
		const startedAt = new Date();
		let entries: LdapUserEntry[] = [];
		let error = '';
		let status: AuthProviderSyncHistory['status'] = 'success';

		try {
			entries = await this.searchWithAdminBinding(this.buildSyncFilter());
		} catch (e) {
			status = 'error';
			error = e instanceof Error ? e.message : String(e);
		}

		const mapped: MappedLdapUser[] = [];
		// A directory entry with a bad email is skipped (not created/updated) but
		// still counts as "seen" so an existing linked user is not disabled.
		const seenLdapIds = new Set<string>();
		for (const entry of entries) {
			const user = mapLdapUser(entry, this.config);
			seenLdapIds.add(user.ldapId);
			if (!isValidEmail(user.email)) {
				this.logger.warn(`LDAP - Invalid email format for user ${user.ldapId}`);
				continue;
			}
			mapped.push(user);
		}

		const identities = await getLdapIdentities();
		const identityByLdapId = new Map(identities.map((i) => [i.providerId, i]));

		const toCreate = mapped.filter((u) => !identityByLdapId.has(u.ldapId));
		const toUpdate = mapped.filter((u) => identityByLdapId.has(u.ldapId));
		const toDisable = identities.filter((i) => !seenLdapIds.has(i.providerId));

		if (mode === 'live' && status === 'success') {
			try {
				for (const user of toCreate) await createLdapMember(user);
				for (const user of toUpdate) {
					await updateLdapMember(user, identityByLdapId.get(user.ldapId)!.userId);
				}
				await disableLdapMembers(toDisable.map((i) => i.userId));
			} catch (e) {
				status = 'error';
				error = e instanceof Error ? e.message : String(e);
			}
		}

		const synchronization: Omit<AuthProviderSyncHistory, 'id' | 'providerType'> = {
			runMode: mode,
			status,
			startedAt,
			endedAt: new Date(),
			scanned: entries.length,
			created: toCreate.length,
			updated: toUpdate.length,
			disabled: toDisable.length,
			error,
		};
		await saveLdapSynchronization(synchronization);

		this.eventService.emit('ldap-general-sync-finished', {
			type: mode,
			succeeded: status === 'success',
			usersSynced: toCreate.length + toUpdate.length + toDisable.length,
			error,
		});

		this.logger.debug(`LDAP sync finished (${mode})`, { status, scanned: entries.length });
		return synchronization as AuthProviderSyncHistory;
	}

	/** Stop the scheduled synchronization timer (shutdown hook). */
	stopSync(): void {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
	}

	private scheduleSync(): void {
		this.stopSync();
		if (!this.config.loginEnabled || !this.config.synchronizationEnabled) return;
		if (!this.config.synchronizationInterval || this.config.synchronizationInterval <= 0) {
			throw new UnexpectedError('LDAP synchronization interval must be a positive number');
		}
		this.syncTimer = setInterval(() => {
			void this.runSync('live').catch((e: Error) =>
				this.logger.error('Scheduled LDAP sync failed', { error: e.message }),
			);
		}, this.config.synchronizationInterval * 60_000);
		this.syncTimer.unref?.();
	}

	/** Mirror login flags into GlobalConfig for hot-path readers (login page, email auth handler). */
	private applyRuntimeMirrors(): void {
		this.globalConfig.sso.ldap.loginEnabled = this.config.loginEnabled;
		this.globalConfig.sso.ldap.loginLabel = this.config.loginLabel;
	}

	private createClient(): Client {
		const { connectionUrl, connectionPort, connectionSecurity, allowUnauthorizedCerts } =
			this.config;
		if (!connectionUrl) {
			throw new LdapConnectionError('No LDAP server configured');
		}
		const scheme = connectionSecurity === 'tls' ? 'ldaps' : 'ldap';
		return new Client({
			url: `${scheme}://${connectionUrl}:${connectionPort}`,
			timeout: this.config.searchTimeout * 1000,
			tlsOptions: { rejectUnauthorized: !allowUnauthorizedCerts },
			...(connectionSecurity === 'startTls' ? { startTLS: true } : {}),
		});
	}

	private async bindAdmin(client: Client): Promise<void> {
		let password = this.config.bindingAdminPassword;
		try {
			password = this.cipher.decrypt(password);
		} catch {
			// Stored plaintext (e.g. never re-saved after an import) — use as-is.
		}
		try {
			await client.bind(this.config.bindingAdminDn, password);
		} catch (e) {
			throw new LdapConnectionError(e instanceof Error ? e.message : String(e));
		}
	}
}

/** RFC 4515 escaping for values interpolated into LDAP search filters. */
function escapeLdapFilterValue(value: string): string {
	return value
		.replace(/\\/g, '\\5c')
		.replace(/\*/g, '\\2a')
		.replace(/\(/g, '\\28')
		.replace(/\)/g, '\\29')
		.replace(/\0/g, '\\00');
}
