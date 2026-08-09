import { ProjectRelationRepository, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { EntityManager } from '@n8n/typeorm';

import type { ICredentialConnectionStatusProvider } from '@/credentials/credential-connection-status-provider.interface';
import { userHasScopes } from '@/permissions/check-access';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { DynamicCredentialUserEntryRepository } from '../database/repositories/dynamic-credential-user-entry.repository';

/**
 * Per-user connection state for end-user credentials, registered on
 * `CredentialConnectionStatusProxy` at module init.
 *
 * "Connected" always means the system resolver: a user connects their own n8n
 * account, so only `SYSTEM_RESOLVER_ID` rows count towards the badges and
 * counts shown in the UI. Cleanup, by contrast, spans every resolver — losing
 * access to a credential must drop all of that user's data for it.
 */
@Service()
export class CredentialConnectionStatusService implements ICredentialConnectionStatusProvider {
	constructor(
		private readonly userEntryRepository: DynamicCredentialUserEntryRepository,
		private readonly userRepository: UserRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
	) {}

	async findConnectedCredentialIds(userId: string, credentialIds: string[]): Promise<Set<string>> {
		if (credentialIds.length === 0) return new Set();

		const connected = await this.userEntryRepository.findConnectedCredentialIds(
			userId,
			credentialIds,
			SYSTEM_RESOLVER_ID,
		);
		return new Set(connected);
	}

	async countConnectedUsers(credentialId: string): Promise<number> {
		return await this.userEntryRepository.countDistinctUsers(credentialId, SYSTEM_RESOLVER_ID);
	}

	async deleteAllUserEntries(credentialId: string, em?: EntityManager): Promise<void> {
		await this.userEntryRepository.deleteAllForCredential(credentialId, em);
	}

	async cleanupOrphanedEntriesForUsers(
		userIds: string[],
		em?: EntityManager,
		credentialId?: string,
	): Promise<void> {
		if (userIds.length === 0) return;

		const credentialIds = credentialId
			? [credentialId]
			: await this.userEntryRepository.findConnectedCredentialIdsForUsers(userIds, em);
		if (credentialIds.length === 0) return;

		const users = await this.userRepository.findManyByIds(userIds, { includeRole: true });

		for (const id of credentialIds) {
			const orphaned: string[] = [];
			for (const user of users) {
				if (!(await userHasScopes(user, ['credential:connect'], false, { credentialId: id }, em))) {
					orphaned.push(user.id);
				}
			}
			await this.userEntryRepository.deleteForUsers(orphaned, id, em);
		}
	}

	async cleanupOrphanedEntriesForProjects(
		credentialId: string,
		projectIds: string[],
		em?: EntityManager,
	): Promise<void> {
		if (projectIds.length === 0) return;

		const userIds = new Set<string>();
		for (const projectId of projectIds) {
			for (const userId of await this.projectRelationRepository.findUserIdsByProjectId(projectId)) {
				userIds.add(userId);
			}
		}

		await this.cleanupOrphanedEntriesForUsers([...userIds], em, credentialId);
	}
}
