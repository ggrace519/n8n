import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';

/**
 * The link between resolvers and the workflows that select them through
 * `settings.credentialResolverId` — used to warn before a resolver is removed
 * and to clean the setting up afterwards.
 */
@Service()
export class CredentialResolverWorkflowService {
	constructor(private readonly workflowRepository: WorkflowRepository) {}

	/** Workflows that explicitly select this resolver. */
	async findAffectedWorkflows(resolverId: string) {
		return await this.workflowRepository.findByCredentialResolverId(resolverId);
	}

	/** Ids of the affected workflows that are currently published. */
	async findActiveWorkflowIds(resolverId: string): Promise<string[]> {
		return await this.workflowRepository.findActiveByCredentialResolverId(resolverId);
	}

	/** Drops the resolver from every workflow's settings. */
	async clearResolverFromWorkflows(resolverId: string): Promise<void> {
		await this.workflowRepository.clearCredentialResolverId(resolverId);
	}
}
