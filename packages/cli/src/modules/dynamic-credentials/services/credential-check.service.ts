import { Logger } from '@n8n/backend-common';
import { CredentialsRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import type {
	CredentialCheckResult,
	CredentialCheckStatus,
	DynamicCredentialCheckProxyProvider,
	INode,
} from 'n8n-workflow';
import { toCredentialContext } from 'n8n-workflow';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { N8NIdentifier } from '../credential-resolvers/identifiers/n8n-identifier';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';

/**
 * Pre-execution gate exposed through the module's workflow context: tells a
 * webhook/MCP trigger whether every end-user credential the workflow needs is
 * already connected for the identity that triggered it, before anything runs.
 */
@Service()
export class CredentialCheckService implements DynamicCredentialCheckProxyProvider {
	constructor(
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly n8nIdentifier: N8NIdentifier,
		private readonly workflowRepository: WorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
	) {}

	async checkCredentialStatus(
		workflowId: string,
		executionContext: { credentials?: string },
	): Promise<CredentialCheckResult> {
		const workflow = await this.workflowRepository.findById(workflowId);
		if (!workflow) return { readyToExecute: true, credentials: [] };

		const credentialIds = collectCredentialIds(workflow.nodes ?? []);
		if (credentialIds.length === 0) return { readyToExecute: true, credentials: [] };

		const resolvable = (await this.credentialsRepository.getManyByIds(credentialIds)).filter(
			(credential) => credential.isResolvable,
		);
		if (resolvable.length === 0) return { readyToExecute: true, credentials: [] };

		const userId = await this.resolveUserId(executionContext, workflowId);

		const credentials: CredentialCheckStatus[] = [];
		for (const credential of resolvable) {
			const resolverId =
				credential.resolverId ?? workflow.settings?.credentialResolverId ?? SYSTEM_RESOLVER_ID;

			credentials.push({
				credentialId: credential.id,
				credentialName: credential.name,
				credentialType: credential.type,
				resolverId,
				status: await this.statusFor(credential.id, resolverId, userId),
			});
		}

		return {
			readyToExecute: credentials.every((c) => c.status === 'configured'),
			credentials,
		};
	}

	private async statusFor(
		credentialId: string,
		resolverId: string,
		userId: string | null,
	): Promise<CredentialCheckStatus['status']> {
		// Only the system resolver keys on an n8n user, so it is the only one this
		// gate can answer for; anything else is reported as unresolvable here.
		if (resolverId !== SYSTEM_RESOLVER_ID) return 'resolver_missing';
		if (userId === null) return 'missing';

		const data = await this.userEntryStorage.getCredentialData(
			credentialId,
			userId,
			resolverId,
			{},
		);
		return data === null ? 'missing' : 'configured';
	}

	private async resolveUserId(
		executionContext: { credentials?: string },
		workflowId: string,
	): Promise<string | null> {
		if (!executionContext.credentials) return null;

		try {
			const context = toCredentialContext(
				await this.cipher.decryptV2(executionContext.credentials),
			);
			return await this.n8nIdentifier.resolve(context, {});
		} catch (error) {
			this.logger.debug('Could not identify the user behind a credential-status check', {
				workflowId,
				error,
			});
			return null;
		}
	}
}

function collectCredentialIds(nodes: INode[]): string[] {
	const ids = new Set<string>();
	for (const node of nodes) {
		for (const credential of Object.values(node.credentials ?? {})) {
			if (credential.id) ids.add(credential.id);
		}
	}
	return [...ids];
}
