import type { LdapConfig } from '@n8n/constants';
import type { AuthProviderSyncHistory, User } from '@n8n/db';
import {
	AuthIdentity,
	AuthIdentityRepository,
	AuthProviderSyncHistoryRepository,
	UserRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { Entry as LdapUser } from 'ldapts';

/** Attributes of a directory entry mapped through the instance's LDAP config. */
export type MappedLdapUser = {
	ldapId: string;
	email: string;
	firstName: string;
	lastName: string;
	loginId: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_REGEX.test(email);
}

function attributeToString(value: LdapUser[keyof LdapUser]): string {
	if (Array.isArray(value)) {
		const first = value[0];
		return first === undefined ? '' : first.toString();
	}
	return value === undefined ? '' : value.toString();
}

/** Map a raw directory entry to user attributes via the configured attribute names. */
export function mapLdapUser(entry: LdapUser, config: LdapConfig): MappedLdapUser {
	return {
		ldapId: attributeToString(entry[config.ldapIdAttribute]),
		email: attributeToString(entry[config.emailAttribute]).toLowerCase(),
		firstName: attributeToString(entry[config.firstNameAttribute]),
		lastName: attributeToString(entry[config.lastNameAttribute]),
		loginId: attributeToString(entry[config.loginIdAttribute]),
	};
}

/** Persist one synchronization run (provider type is always `ldap`). */
export async function saveLdapSynchronization(
	data: Omit<AuthProviderSyncHistory, 'id' | 'providerType'>,
): Promise<void> {
	await Container.get(AuthProviderSyncHistoryRepository).save(
		{ ...data, providerType: 'ldap' },
		{ transaction: false },
	);
}

/** LDAP synchronization runs, newest first, with the total count. */
export async function getLdapSynchronizationsWithCount(
	offset: number,
	limit: number,
): Promise<[AuthProviderSyncHistory[], number]> {
	return await Container.get(AuthProviderSyncHistoryRepository).findAndCount({
		where: { providerType: 'ldap' },
		order: { id: 'DESC' },
		skip: offset,
		take: limit,
	});
}

/** All local LDAP identities with their users. */
export async function getLdapIdentities(): Promise<AuthIdentity[]> {
	return await Container.get(AuthIdentityRepository).find({
		where: { providerType: 'ldap' },
		relations: { user: { role: true } },
	});
}

/** LDAP synchronization runs, newest first (no total). */
export async function getLdapSynchronizations(
	offset: number,
	limit: number,
): Promise<AuthProviderSyncHistory[]> {
	return await Container.get(AuthProviderSyncHistoryRepository).find({
		where: { providerType: 'ldap' },
		order: { id: 'DESC' },
		skip: offset,
		take: limit,
	});
}

/** The local users linked to an LDAP identity. */
export async function getLdapUsers(): Promise<User[]> {
	const identities = await getLdapIdentities();
	return identities.map((identity) => identity.user);
}

/** Create a new (global member) user for a directory entry, with their personal project. */
export async function createLdapMember(attributes: MappedLdapUser): Promise<User> {
	const userRepository = Container.get(UserRepository);
	const { user } = await userRepository.createUserWithProject({
		email: attributes.email,
		firstName: attributes.firstName,
		lastName: attributes.lastName,
		role: { slug: 'global:member' },
		// LDAP users authenticate against the directory — no local password.
		password: null,
	});
	await Container.get(AuthIdentityRepository).save(
		AuthIdentity.create(user, attributes.ldapId, 'ldap'),
		{ transaction: false },
	);
	return user;
}

/** Update the mapped fields of the local user linked to an LDAP identity. */
export async function updateLdapMember(attributes: MappedLdapUser, userId: string): Promise<void> {
	await Container.get(UserRepository).update(
		{ id: userId },
		{
			email: attributes.email,
			firstName: attributes.firstName,
			lastName: attributes.lastName,
			disabled: false,
		},
	);
}

/** Disable local users that vanished from the directory and drop their LDAP identity. */
export async function disableLdapMembers(userIds: string[]): Promise<void> {
	if (userIds.length === 0) return;
	const userRepository = Container.get(UserRepository);
	const authIdentityRepository = Container.get(AuthIdentityRepository);
	for (const userId of userIds) {
		await userRepository.update({ id: userId }, { disabled: true });
		await authIdentityRepository.delete({ userId, providerType: 'ldap' });
	}
}

/** Remove all LDAP identities, keeping the linked accounts as email users. */
export async function deleteAllLdapIdentities(): Promise<void> {
	await Container.get(AuthIdentityRepository).delete({ providerType: 'ldap' });
}
