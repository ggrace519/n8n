import type { EntityManager, User } from '@n8n/db';
import { SharedCredentialsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { ProjectService } from '@/services/project.service';

import { CredentialsFinderService } from './credentials-finder.service';
import { CredentialsService } from './credentials.service';

/**
 * Sharing-aware credential operations: resolving a credential through ANY of
 * the caller's granting project/sharing roles (not just personal ownership),
 * sharing it into other projects, and transferring ownership between projects.
 */
@Service()
export class EnterpriseCredentialsService {
	constructor(
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly credentialsService: CredentialsService,
		private readonly projectService: ProjectService,
	) {}

	/**
	 * The credential (with its sharing relations), resolved through the user's
	 * roles. Data is decrypted (and redacted) only when requested AND the
	 * user's roles grant `credential:update` on it; the per-user/oauth signal
	 * handling mirrors the community `CredentialsService.getOne`.
	 */
	async getOneForUser(user: User, credentialId: string, includeDecryptedData: boolean) {
		let decryptedData: ICredentialDataDecryptedObject | null = null;

		let credential = includeDecryptedData
			? await this.credentialsFinderService.findCredentialForUser(credentialId, user, [
					'credential:read',
					'credential:update',
				])
			: null;

		if (credential) {
			// `decrypt` redacts by default — raw secrets never reach the response.
			decryptedData = await this.credentialsService.decrypt(credential);
		} else {
			credential = await this.credentialsFinderService.findCredentialForUser(credentialId, user, [
				'credential:read',
			]);
		}

		if (!credential) {
			throw new NotFoundError(`Credential with ID "${credentialId}" could not be found.`);
		}

		const { data: _, ...rest } = credential;

		const enriched: typeof rest & { connectedByMe?: boolean; connectedUserCount?: number } = rest;
		await this.credentialsService.populateConnectedByMe([enriched], user);

		if (credential.isResolvable) {
			enriched.connectedUserCount = await this.credentialsService.countConnectedUsers(
				credential.id,
			);
		}

		if (decryptedData) {
			// We never want to expose the oauthTokenData itself to the frontend —
			// it only checks whether the credential is already connected.
			if (credential.isResolvable) {
				// For resolvable credentials the "connected" signal is per-user.
				if (enriched.connectedByMe) {
					decryptedData.oauthTokenData = true;
				} else {
					delete decryptedData.oauthTokenData;
				}
			} else if (decryptedData.oauthTokenData) {
				decryptedData.oauthTokenData = true;
			}
			return { data: decryptedData, ...enriched };
		}

		return { ...enriched };
	}

	/** Share the credential into the given projects with the `credential:user` role. */
	async shareWithProjects(
		_user: User,
		credentialId: string,
		shareWithProjectIds: string[],
		entityManager?: EntityManager,
	) {
		await this.sharedCredentialsRepository.shareWithProjects(
			credentialId,
			shareWithProjectIds,
			entityManager,
		);
	}

	/**
	 * Move a credential to another project: the caller needs `credential:move`
	 * on the credential and `credential:create` in the destination. All
	 * existing sharings are removed; the destination becomes the sole owner.
	 */
	async transferOne(user: User, credentialId: string, destinationProjectId: string) {
		const credential = await this.credentialsFinderService.findCredentialForUser(
			credentialId,
			user,
			['credential:move'],
		);
		if (!credential) {
			throw new NotFoundError(`Could not find credential with ID "${credentialId}".`);
		}

		const ownerSharing = credential.shared?.find((sharing) => sharing.role === 'credential:owner');
		if (ownerSharing?.projectId === destinationProjectId) {
			throw new BadRequestError(
				'The credential is already owned by the destination project. It cannot be transferred to itself.',
			);
		}

		const destinationProject = await this.projectService.getProjectWithScope(
			user,
			destinationProjectId,
			['credential:create'],
		);
		if (!destinationProject) {
			throw new NotFoundError(`Could not find project to transfer to. ID: ${destinationProjectId}`);
		}

		await this.sharedCredentialsRepository.transferOwnership(credentialId, destinationProjectId);
	}
}
