import type { Project, User } from '@n8n/db';
import { ProjectRelationRepository, ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope, PROJECT_ADMIN_ROLE_SLUG } from '@n8n/permissions';

import { RoleService } from '@/services/role.service';

/**
 * Answers "which projects does this user administer for source control?".
 *
 * A user has instance-wide source-control authority when their global role
 * grants `sourceControl:push` (owner/admin). Otherwise their authority is
 * limited to the team projects where they hold a role granting project-level
 * `sourceControl:push` — a team-project admin, or a custom role carrying the
 * scope. Personal projects and editor/viewer/member roles never confer
 * source-control authority.
 */
@Service()
export class SourceControlScopedService {
	constructor(
		private readonly roleService: RoleService,
		private readonly projectRepository: ProjectRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
	) {}

	/** Whether the user's global role grants instance-wide source-control push authority. */
	hasInstanceWideAuthority(user: User): boolean {
		return hasGlobalScope(user, 'sourceControl:push');
	}

	/**
	 * Team projects the user administers for source control.
	 * Returns `null` for instance-wide authority (all projects).
	 */
	async getAuthorizedTeamProjects(user: User): Promise<Project[] | null> {
		if (this.hasInstanceWideAuthority(user)) return null;

		// Roles (static + custom) granting project-level source-control push.
		// The static team-project admin is included explicitly: administering a
		// team project is the baseline grant for scoped source-control access.
		const roles = await this.roleService.rolesWithScope('project', ['sourceControl:push']);
		const roleSlugs = [...new Set([...roles, PROJECT_ADMIN_ROLE_SLUG])];

		const projectIds = await this.projectRelationRepository.getAccessibleProjectsByRoles(
			user.id,
			roleSlugs,
		);
		if (projectIds.length === 0) return [];

		const projects = await this.projectRepository.findByIds(projectIds);
		// Personal projects are excluded: only team projects participate in
		// project-scoped source control.
		return projects.filter((project) => project.type === 'team');
	}

	/**
	 * IDs of the team projects the user administers for source control.
	 * Returns `null` for instance-wide authority (all projects).
	 */
	async getAuthorizedTeamProjectIds(user: User): Promise<string[] | null> {
		const projects = await this.getAuthorizedTeamProjects(user);
		return projects === null ? null : projects.map((project) => project.id);
	}
}
