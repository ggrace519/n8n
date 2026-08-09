import { GlobalConfig } from '@n8n/config';
import { AuthIdentity, AuthIdentityRepository, User, UserRepository } from '@n8n/db';
import type { IPasswordAuthHandler } from '@n8n/decorators';
import { AuthHandler } from '@n8n/decorators';
import type { Constructable } from '@n8n/di';

import { EventService } from '@/events/event.service';

import { createLdapMember, isValidEmail, mapLdapUser } from './helpers';
import { LdapService } from './ldap.service';

/**
 * Password login against the LDAP directory. On success the directory entry
 * is synchronized into the local account: a new member is created, an
 * existing LDAP user's mapped fields are refreshed (and re-enabled), or a
 * matching email account is converted by attaching an LDAP identity.
 */
@AuthHandler()
export class LdapAuthHandler implements IPasswordAuthHandler<User> {
	readonly metadata = { name: 'ldap', type: 'password' as const };

	readonly userClass: Constructable<User> = User;

	constructor(
		private readonly ldapService: LdapService,
		private readonly userRepository: UserRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly globalConfig: GlobalConfig,
		private readonly eventService: EventService,
	) {}

	async handleLogin(loginId: string, password: string): Promise<User | undefined> {
		if (!this.globalConfig.sso.ldap.loginEnabled) return undefined;

		const entries = await this.ldapService.searchWithAdminBinding(
			this.ldapService.buildLoginFilter(loginId),
		);
		if (entries.length === 0) return undefined;

		const entry = entries[0];
		try {
			await this.ldapService.validUser(entry.dn.toString(), password);
		} catch {
			return undefined;
		}

		const attributes = mapLdapUser(entry, this.ldapService.getConfig());
		if (!isValidEmail(attributes.email)) return undefined;

		try {
			return await this.syncLocalUser(attributes);
		} catch (error) {
			this.eventService.emit('ldap-login-sync-failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private async syncLocalUser(attributes: {
		ldapId: string;
		email: string;
		firstName: string;
		lastName: string;
	}): Promise<User> {
		const identity = await this.authIdentityRepository.findOne({
			where: { providerId: attributes.ldapId, providerType: 'ldap' },
			relations: { user: { role: true } },
		});

		if (identity) {
			await this.userRepository.update(
				{ id: identity.userId },
				{
					email: attributes.email,
					firstName: attributes.firstName,
					lastName: attributes.lastName,
					disabled: false,
				},
			);
			return (await this.userRepository.findOne({
				where: { id: identity.userId },
				relations: ['role', 'authIdentities'],
			}))!;
		}

		// An existing email account with the same address is converted in place:
		// attach the LDAP identity and adopt the directory's mapped fields.
		const existingUser = await this.userRepository.findOne({
			where: { email: attributes.email },
			relations: ['role', 'authIdentities'],
		});
		if (existingUser) {
			await this.authIdentityRepository.save(
				AuthIdentity.create(existingUser, attributes.ldapId, 'ldap'),
				{ transaction: false },
			);
			await this.userRepository.update(
				{ id: existingUser.id },
				{
					firstName: attributes.firstName,
					lastName: attributes.lastName,
					disabled: false,
				},
			);
			return (await this.userRepository.findOne({
				where: { id: existingUser.id },
				relations: ['role', 'authIdentities'],
			}))!;
		}

		const created = await createLdapMember({ ...attributes, loginId: attributes.email });
		return (await this.userRepository.findOne({
			where: { id: created.id },
			relations: ['role', 'authIdentities'],
		}))!;
	}
}
