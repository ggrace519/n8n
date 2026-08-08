import type { User } from '@n8n/db';
import { ProjectRelationRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope, type Scope } from '@n8n/permissions';

import { RoleService } from '@/services/role.service';

@Service()
export class ProjectScopeService {
	constructor(
		private readonly roleService: RoleService,
		private readonly projectRelationRepository: ProjectRelationRepository,
	) {}

	/**
	 * IDs of the projects in which the user's project role grants ALL the
	 * given scopes. Returns `null` when the user's global role already grants
	 * them everywhere, meaning "no project filter applies" — callers treat
	 * `null` as unrestricted access.
	 */
	async getProjectIds(user: User, scopes: Scope[]): Promise<string[] | null> {
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) return null;

		const projectRoles = await this.roleService.rolesWithScope('project', scopes);
		return await this.projectRelationRepository.getAccessibleProjectsByRoles(user.id, projectRoles);
	}
}
