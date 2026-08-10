import type { WorkflowReviewEligibleReviewer } from '@n8n/api-types';
import type { User, WorkflowEntity, WorkflowReviewAccessFilter } from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope, type Scope } from '@n8n/permissions';

import { RoleService } from '@/services/role.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { WorkflowReviewUserRepository } from './database/workflow-review-user.repository';

/** Scopes required to open or re-pin a review, matching the submit-for-publication UI. */
export const REVIEW_AUTHORING_SCOPES: Scope[] = ['workflow:update', 'workflow:publish'];

/** Scope required to decide a review. */
export const REVIEW_DECISION_SCOPES: Scope[] = ['workflow:publish'];

/**
 * The one place that answers "may this user do this to this review". Every route
 * goes through it — the repositories enforce nothing, so a query that skips this
 * service is an unauthorized read.
 */
@Service()
export class WorkflowReviewAccessService {
	constructor(
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly roleService: RoleService,
		private readonly userRepository: WorkflowReviewUserRepository,
	) {}

	/**
	 * Which reviews the user may see at all. Resolved from role slugs rather than
	 * role names so custom roles and scope-stripping project settings are honoured.
	 */
	async resolveReadAccessFilter(user: User): Promise<WorkflowReviewAccessFilter> {
		if (hasGlobalScope(user, 'workflow:read')) return { kind: 'all' };

		const [projectRoleSlugs, workflowRoleSlugs] = await Promise.all([
			this.roleService.rolesWithScope('project', ['workflow:read']),
			this.roleService.rolesWithScope('workflow', ['workflow:read']),
		]);

		return { kind: 'scoped', userId: user.id, projectRoleSlugs, workflowRoleSlugs };
	}

	async findWorkflowWithScopes(
		workflowId: string,
		user: User,
		scopes: Scope[],
	): Promise<WorkflowEntity | null> {
		return await this.workflowFinderService.findWorkflowForUser(workflowId, user, scopes);
	}

	async canReadWorkflow(workflowId: string, user: User): Promise<boolean> {
		return (await this.findWorkflowWithScopes(workflowId, user, ['workflow:read'])) !== null;
	}

	async canPublishWorkflow(workflowId: string, user: User): Promise<boolean> {
		return (await this.findWorkflowWithScopes(workflowId, user, REVIEW_DECISION_SCOPES)) !== null;
	}

	/**
	 * Users who could decide a review on this workflow: they hold
	 * `workflow:publish` and are not authors of the request. Authors are excluded
	 * because an author may never decide their own review, so offering them as a
	 * reviewer would only produce a request nobody can act on.
	 */
	async listEligibleReviewers(
		workflowId: string,
		excludeUserIds: string[] = [],
	): Promise<WorkflowReviewEligibleReviewer[]> {
		const [projectRoleSlugs, workflowRoleSlugs, globalRoleSlugs] = await Promise.all([
			this.roleService.rolesWithScope('project', REVIEW_DECISION_SCOPES),
			this.roleService.rolesWithScope('workflow', REVIEW_DECISION_SCOPES),
			this.roleService.rolesWithScope('global', REVIEW_DECISION_SCOPES),
		]);

		const users = await this.userRepository.findUsersWithWorkflowScope({
			workflowId,
			projectRoleSlugs,
			workflowRoleSlugs,
			globalRoleSlugs,
		});

		const excluded = new Set(excludeUserIds);

		return (
			users
				.filter((user) => !excluded.has(user.id))
				// A disabled account cannot sign in, and an invited-but-not-signed-up one
				// has no way to review yet; neither is a usable reviewer.
				.filter((user) => !user.disabled && !user.isPending)
				.map(toEligibleReviewer)
				.sort((a, b) => a.email.localeCompare(b.email))
		);
	}
}

/**
 * Projection boundary for user data leaving the review endpoints — only these
 * four fields are ever exposed, whatever else the row carries.
 */
export function toEligibleReviewer(user: User): WorkflowReviewEligibleReviewer {
	return {
		id: user.id,
		email: user.email,
		firstName: user.firstName ?? null,
		lastName: user.lastName ?? null,
	};
}
