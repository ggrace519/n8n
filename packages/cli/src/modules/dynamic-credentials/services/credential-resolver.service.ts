import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IExecutionContext,
	IWorkflowSettings,
} from 'n8n-workflow';
import { jsonParse, toCredentialContext } from 'n8n-workflow';

import type {
	CredentialResolutionResult,
	CredentialResolveMetadata,
	ICredentialResolutionProvider,
} from '@/credentials/credential-resolution-provider.interface';
import type {
	CredentialStoreMetadata,
	IDynamicCredentialStorageProvider,
} from '@/credentials/dynamic-credential-storage.interface';
import { OAuthTokenVerifierProxy } from '@/services/oauth-token-verifier-proxy.service';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { N8NIdentifier } from '../credential-resolvers/identifiers/n8n-identifier';
import {
	EXTERNAL_IDENTITY_SOURCE,
	OAuth2UserinfoIdentifier,
} from '../credential-resolvers/identifiers/oauth2-userinfo-identifier';
import { DynamicCredentialEntryStorage } from '../credential-resolvers/storage/dynamic-credential-entry-storage';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';
import { CredentialResolutionError } from '../errors/credential-resolution.error';

const UNRESOLVED_MESSAGE =
	"This node uses an end-user credential, but no user could be identified for this run, so the credential for it couldn't be resolved";

/** Where a resolved subject's data lives, and whether it names an n8n user. */
type ResolvedSubject = {
	subjectId: string;
	/** Set only when the subject *is* an n8n user (system resolver). */
	userId?: string;
};

/**
 * Reads and writes end-user credential data for one execution identity.
 *
 * Registered on `DynamicCredentialsProxy` as both the resolution and the
 * storage provider, so `CredentialsHelper` and the OAuth token write path
 * reach it without importing this module.
 */
@Service()
export class CredentialResolverService
	implements ICredentialResolutionProvider, IDynamicCredentialStorageProvider
{
	constructor(
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly n8nIdentifier: N8NIdentifier,
		private readonly oauth2UserinfoIdentifier: OAuth2UserinfoIdentifier,
		private readonly oauthTokenVerifier: OAuthTokenVerifierProxy,
		private readonly resolverRepository: DynamicCredentialResolverRepository,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
		private readonly entryStorage: DynamicCredentialEntryStorage,
	) {}

	getSystemResolverId(): string | null {
		return SYSTEM_RESOLVER_ID;
	}

	async resolveIfNeeded(
		metadata: CredentialResolveMetadata,
		staticData: ICredentialDataDecryptedObject,
		executionContext?: IExecutionContext,
		workflowSettings?: IWorkflowSettings,
	): Promise<CredentialResolutionResult> {
		if (!metadata.isResolvable) return { data: staticData, isDynamic: false };

		const resolverId = this.effectiveResolverId(metadata, workflowSettings);
		const credentialContext = await this.readCredentialContext(executionContext, metadata);
		const subject = await this.resolveSubject(credentialContext, resolverId, metadata);

		const stored = subject.userId
			? await this.userEntryStorage.getCredentialData(metadata.id, subject.userId, resolverId, {})
			: await this.entryStorage.getCredentialData(metadata.id, subject.subjectId, resolverId, {});

		if (stored === null) {
			this.logger.debug('No end-user credential data stored for the resolved subject', {
				credentialId: metadata.id,
				resolverId,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}

		const dynamicData = await this.decryptEntry(stored, metadata.id);

		return {
			// The per-identity payload wins; shared configuration (client id/secret,
			// base URLs) still comes from the credential's static data.
			data: { ...staticData, ...dynamicData },
			isDynamic: true,
			resolvedUserId: subject.userId,
		};
	}

	async storeIfNeeded(
		metadata: CredentialStoreMetadata,
		dynamicData: ICredentialDataDecryptedObject,
		credentialContext: ICredentialContext,
		_staticData?: ICredentialDataDecryptedObject,
		workflowSettings?: IWorkflowSettings,
	): Promise<void> {
		if (!metadata.isResolvable) return;

		const resolverId = this.effectiveResolverId(metadata, workflowSettings);
		const subject = await this.resolveSubject(credentialContext, resolverId, metadata);
		const encrypted = await this.cipher.encryptV2(dynamicData);

		if (subject.userId) {
			await this.userEntryStorage.setCredentialData(
				metadata.id,
				subject.userId,
				resolverId,
				encrypted,
				{},
			);
			return;
		}

		await this.entryStorage.setCredentialData(
			metadata.id,
			subject.subjectId,
			resolverId,
			encrypted,
			{},
		);
	}

	/** Credential-level resolver, else the workflow's, else the seeded system one. */
	private effectiveResolverId(
		metadata: { resolverId?: string },
		workflowSettings?: IWorkflowSettings,
	): string {
		return metadata.resolverId ?? workflowSettings?.credentialResolverId ?? SYSTEM_RESOLVER_ID;
	}

	private async readCredentialContext(
		executionContext: IExecutionContext | undefined,
		metadata: CredentialResolveMetadata,
	): Promise<ICredentialContext> {
		if (!executionContext?.credentials) {
			this.logger.debug('No credential context available to resolve an end-user credential', {
				credentialId: metadata.id,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}

		try {
			return toCredentialContext(await this.cipher.decryptV2(executionContext.credentials));
		} catch (error) {
			this.logger.warn('Failed to read the credential context of this execution', {
				credentialId: metadata.id,
				error,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}
	}

	/**
	 * Identifies the external subject `identity` names under a non-system
	 * resolver. Only resolver types that can *verify* the identity are accepted;
	 * the raw identity string is never used as a storage key, so an unverifiable
	 * caller can't claim (or mint) another subject's credential data.
	 */
	async resolveExternalSubject(
		resolverId: string,
		identity: string,
		credentialId: string,
	): Promise<string> {
		const resolver = await this.resolverRepository.findById(resolverId, {});
		if (!resolver) {
			this.logger.warn('End-user credential points at a resolver that no longer exists', {
				credentialId,
				resolverId,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}

		const config = await this.decryptResolverConfig(resolver.config, resolverId);
		if (!OAuth2UserinfoIdentifier.supports(resolver.type, config)) {
			this.logger.warn('Credential resolver type cannot verify external identities', {
				resolverId,
				type: resolver.type,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}
		return await this.oauth2UserinfoIdentifier.resolve(identity, config);
	}

	/**
	 * Turns the context identity into the key the credential data is stored
	 * under. The system resolver maps it to an n8n user; any other resolver must
	 * verify the identity (see `resolveExternalSubject`).
	 */
	private async resolveSubject(
		credentialContext: ICredentialContext,
		resolverId: string,
		metadata: { id: string },
	): Promise<ResolvedSubject> {
		if (resolverId !== SYSTEM_RESOLVER_ID) {
			// Never forward an n8n session or n8n-issued token to a third-party provider.
			if (credentialContext.metadata?.source !== EXTERNAL_IDENTITY_SOURCE) {
				this.logger.debug('Refusing to send a non-external identity to a credential resolver', {
					credentialId: metadata.id,
					resolverId,
				});
				throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
			}
			return {
				subjectId: await this.resolveExternalSubject(
					resolverId,
					credentialContext.identity,
					metadata.id,
				),
			};
		}

		const source = credentialContext.metadata?.source;

		if (source === 'n8n-oauth') {
			const resource = credentialContext.metadata?.resource;
			// Links and callbacks carry the identity as an Authorization header; the verifier wants the bare token.
			const { user } = await this.oauthTokenVerifier.verifyOAuthAccessToken(
				credentialContext.identity.replace(/^Bearer\s+/i, ''),
				typeof resource === 'string' ? resource : undefined,
			);
			if (!user) throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
			return { subjectId: user.id, userId: user.id };
		}

		const userId = await this.n8nIdentifier.resolve(credentialContext, {});
		return { subjectId: userId, userId };
	}

	private async decryptResolverConfig(
		config: string,
		resolverId: string,
	): Promise<Record<string, unknown>> {
		try {
			return jsonParse<Record<string, unknown>>(await this.cipher.decryptV2(config));
		} catch (error) {
			this.logger.warn('Credential resolver configuration could not be decrypted', {
				resolverId,
				error,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}
	}

	private async decryptEntry(
		stored: string,
		credentialId: string,
	): Promise<ICredentialDataDecryptedObject> {
		try {
			const plaintext = await this.cipher.decryptV2(stored);
			return jsonParse<ICredentialDataDecryptedObject>(plaintext);
		} catch (error) {
			// Never surface the payload — only that it could not be read.
			this.logger.warn('Stored end-user credential data could not be decrypted', {
				credentialId,
				error,
			});
			throw new CredentialResolutionError(UNRESOLVED_MESSAGE);
		}
	}
}
