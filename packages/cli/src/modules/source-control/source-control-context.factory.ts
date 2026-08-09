import type { Project, User } from '@n8n/db';
import { Service } from '@n8n/di';

import { SourceControlScopedService } from './source-control-scoped.service';

/**
 * Immutable snapshot of a user's source-control authority, resolved once per
 * operation and threaded through export/import/status computations so they
 * never re-query permissions mid-run.
 *
 * `authorizedProjectIds === null` encodes instance-wide authority (global
 * owner/admin); an array limits the caller to those team projects. Personal
 * projects are never listed — personally-owned resources are only visible to
 * instance-wide contexts.
 */
export class SourceControlContext {
	constructor(
		readonly user: User,
		private readonly authorizedProjectIds: string[] | null,
	) {}

	hasAccessToAllProjects(): boolean {
		return this.authorizedProjectIds === null;
	}

	/** Team-project IDs in scope, or `null` when the caller is instance-wide. */
	getAuthorizedProjectIds(): string[] | null {
		return this.authorizedProjectIds === null ? null : [...this.authorizedProjectIds];
	}

	hasAccessToProject(projectId: string): boolean {
		return this.authorizedProjectIds === null || this.authorizedProjectIds.includes(projectId);
	}

	/** Whether the caller has any source-control authority at all. */
	hasAnyAccess(): boolean {
		return this.authorizedProjectIds === null || this.authorizedProjectIds.length > 0;
	}
}

@Service()
export class SourceControlContextFactory {
	constructor(private readonly sourceControlScopedService: SourceControlScopedService) {}

	async createContext(user: User): Promise<SourceControlContext> {
		const projects: Project[] | null =
			await this.sourceControlScopedService.getAuthorizedTeamProjects(user);
		return new SourceControlContext(
			user,
			projects === null ? null : projects.map((project) => project.id),
		);
	}
}
