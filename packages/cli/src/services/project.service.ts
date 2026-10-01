import type { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import type { EntityManager, Project, ProjectRelation, User } from '@n8n/db';
import {
	ProjectRelationRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
} from '@n8n/db';
import { Container, Service } from '@n8n/di';
import {
	combineScopes,
	getAuthPrincipalScopes,
	hasGlobalScope,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_OWNER_ROLE_SLUG,
	type Scope,
} from '@n8n/permissions';
import { UserError } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { RoleService } from '@/services/role.service';

export class TeamProjectOverQuotaError extends UserError {
	constructor(limit: number) {
		super(
			`Attempted to create a new project but quota is already exhausted. You may have a maximum of ${limit} team projects.`,
		);
	}
}

export class UnlicensedProjectRoleError extends UserError {
	constructor(role: string) {
		super(`Your instance is not licensed to use role "${role}".`);
	}
}

type RelationPayload = { userId: string; role: string };

@Service()
export class ProjectService {
	constructor(
		private readonly projectRepository: ProjectRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly roleService: RoleService,
		private readonly licenseState: LicenseState,
	) {}

	// ----------------------------------
	//           project reads
	// ----------------------------------

	/** The project, or throws NotFoundError — for callers that require it to exist. */
	async getProject(projectId: string): Promise<Project> {
		const project = await this.projectRepository.findById(projectId);
		if (!project) {
			throw new NotFoundError(`Could not find project with ID: ${projectId}`);
		}
		return project;
	}

	/** The project, or null — for callers where absence is an expected outcome. */
	async findProject(projectId: string): Promise<Project | null> {
		return await this.projectRepository.findById(projectId);
	}

	async getPersonalProject(user: User): Promise<Project | null> {
		return await this.projectRepository.getPersonalProjectForUser(user.id);
	}

	async getAccessibleProjects(user: User): Promise<Project[]> {
		return await this.projectRepository.getAccessibleProjects(user.id);
	}

	/** Owners and admins list every project; everyone else, the ones they belong to. */
	async getAccessibleProjectsAndCount(
		user: User,
		options: ListProjectsQueryDto,
	): Promise<[Project[], number]> {
		if (hasGlobalScope(user, 'project:list')) {
			return await this.projectRepository.findAllProjectsAndCount(options);
		}
		return await this.projectRepository.getAccessibleProjectsAndCount(user.id, options);
	}

	/** Share targets: every project for owners and admins; otherwise own projects plus peers' personal ones. */
	async getShareableProjectsAndCount(
		user: User,
		options: ListProjectsQueryDto,
	): Promise<[Project[], number]> {
		if (hasGlobalScope(user, 'project:list')) {
			return await this.projectRepository.findAllProjectsAndCount(options);
		}
		return await this.projectRepository.getShareableProjectsAndCount(user.id, options);
	}

	async getProjectCounts() {
		return await this.projectRepository.getProjectCounts();
	}

	/** The subset of the given IDs that exist, so callers can tell "missing" from "forbidden". */
	async findExistingProjectIds(projectIds: string[]): Promise<Set<string>> {
		return new Set(await this.projectRepository.getExistingProjectIds(projectIds));
	}

	/**
	 * The requested projects the user can access with ALL the given scopes,
	 * ordered deterministically (createdAt, then id).
	 */
	async findProjectsByIdsForUser(
		user: User,
		projectIds: string[],
		scopes: Scope[],
	): Promise<Project[]> {
		const projects = await this.projectRepository.findByIds(projectIds);
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) return projects;

		const projectRoles = await this.roleService.rolesWithScope('project', scopes);
		const accessibleIds = new Set(
			await this.projectRelationRepository.getAccessibleProjectsByRoles(user.id, projectRoles),
		);
		return projects.filter((project) => accessibleIds.has(project.id));
	}

	/**
	 * The project, but only if the user's global or project role grants ALL the
	 * given scopes in it; null otherwise. Runs inside `entityManager` when given.
	 */
	async getProjectWithScope(
		user: User,
		projectId: string,
		scopes: Scope[],
		entityManager?: EntityManager,
	): Promise<Project | null> {
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) {
			return await this.projectRepository.findById(projectId, entityManager);
		}

		const projectRoles = await this.roleService.rolesWithScope('project', scopes, entityManager);
		return await this.projectRepository.findByIdForUserWithRoles(
			projectId,
			user.id,
			projectRoles,
			entityManager,
		);
	}

	/** IDs of the projects in which the user's role grants ALL the given scopes. */
	async getProjectIdsWithScope(user: User, scopes: Scope[]): Promise<string[]> {
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) {
			const projects = await this.projectRepository.find({ select: { id: true } });
			return projects.map((project) => project.id);
		}
		const projectRoles = await this.roleService.rolesWithScope('project', scopes);
		return await this.projectRelationRepository.getAccessibleProjectsByRoles(user.id, projectRoles);
	}

	/** IDs of all projects a workflow is shared into (regardless of the caller's access). */
	async findProjectsWorkflowIsIn(workflowId: string): Promise<string[]> {
		return await this.sharedWorkflowRepository.findProjectIds(workflowId);
	}

	// ----------------------------------
	//            relations
	// ----------------------------------

	async getProjectRelations(projectId: string): Promise<ProjectRelation[]> {
		return await this.projectRelationRepository.getRelationsForProject(projectId);
	}

	async getProjectRelationsForUser(user: User): Promise<ProjectRelation[]> {
		return await this.projectRelationRepository.getRelationsForUser(user.id);
	}

	async getProjectRelationForUserAndProject(
		userId: string,
		projectId: string,
	): Promise<ProjectRelation | null> {
		return await this.projectRelationRepository.findRelation(projectId, userId);
	}

	/** Enrich projects with the caller's role and effective scopes in each. */
	async addUserScopes(
		user: User,
		projects: Project[],
	): Promise<Array<Project & { role: string; scopes: Scope[] }>> {
		const relations = await this.getProjectRelationsForUser(user);

		return projects.map((project) => {
			const relation = relations.find((r) => r.projectId === project.id);
			const scopes = [
				...combineScopes({
					global: getAuthPrincipalScopes(user),
					...(relation ? { project: relation.role.scopes.map((scope) => scope.slug) } : {}),
				}),
			].sort();

			// Without a direct relation (e.g. a peer personal project in the share
			// dialog) the caller acts through their global role.
			return { ...project, role: relation?.role.slug ?? user.role.slug, scopes };
		});
	}

	// ----------------------------------
	//            membership
	// ----------------------------------

	/** A personal project has exactly one member, its owner; only team projects take more. */
	private assertTeamProject(project: Project): void {
		if (project.type !== 'team') {
			throw new ForbiddenError('Members can only be managed on team projects');
		}
	}

	/** Add a user to a project, or update their role if already a member. */
	async addUser(projectId: string, { userId, role }: RelationPayload): Promise<void> {
		await this.projectRelationRepository.upsertRelation(projectId, userId, role);
	}

	/** Add users to a project (idempotent; existing members get the new role). */
	async addUsersToProject(projectId: string, relations: RelationPayload[]): Promise<void> {
		this.assertTeamProject(await this.getProject(projectId));
		await this.roleService.checkRolesExist(
			relations.map((relation) => relation.role),
			'project',
		);
		await this.checkChangedRolesLicensed(projectId, relations);
		for (const relation of relations) {
			await this.addUser(projectId, relation);
		}
	}

	/**
	 * Add users to a project, reporting existing members as conflicts instead
	 * of changing their role. Callers derive HTTP semantics (201/409) from the
	 * `added`/`conflicts` arrays.
	 */
	async addUsersWithConflictSemantics<T extends RelationPayload>(
		projectId: string,
		relations: T[],
	): Promise<{
		project: Project;
		added: T[];
		conflicts: Array<{ userId: string; currentRole: string; requestedRole: string }>;
	}> {
		const project = await this.getProject(projectId);
		this.assertTeamProject(project);

		await this.roleService.checkRolesExist(
			relations.map((relation) => relation.role),
			'project',
		);

		const existingRelations =
			await this.projectRelationRepository.getRelationsForProject(projectId);
		const currentRoleByUserId = new Map(
			existingRelations.map((relation) => [relation.userId, relation.role.slug]),
		);

		this.checkRolesLicensed(
			relations
				.filter((relation) => !currentRoleByUserId.has(relation.userId))
				.map((relation) => relation.role),
		);

		const added: T[] = [];
		const conflicts: Array<{ userId: string; currentRole: string; requestedRole: string }> = [];

		for (const relation of relations) {
			const currentRole = currentRoleByUserId.get(relation.userId);
			if (currentRole === undefined) {
				await this.addUser(projectId, relation);
				added.push(relation);
				// Track the addition so a duplicate userId in the same request is
				// reported as a conflict instead of silently overwriting the role.
				currentRoleByUserId.set(relation.userId, relation.role);
			} else if (currentRole !== relation.role) {
				conflicts.push({ userId: relation.userId, currentRole, requestedRole: relation.role });
			}
			// Same role as they already hold → no-op: neither added nor a conflict.
		}

		return { project, added, conflicts };
	}

	/** Replace ALL member relations of a project with the given set. */
	async syncProjectRelations(projectId: string, relations: RelationPayload[]): Promise<void> {
		this.assertTeamProject(await this.getProject(projectId));
		await this.roleService.checkRolesExist(
			relations.map((relation) => relation.role),
			'project',
		);
		await this.checkChangedRolesLicensed(projectId, relations);
		await this.projectRelationRepository.replaceAllRelationsForProject(projectId, relations);
	}

	async changeUserRoleInProject(projectId: string, userId: string, role: string): Promise<void> {
		this.assertTeamProject(await this.getProject(projectId));
		await this.roleService.checkRolesExist([role], 'project');
		this.checkRolesLicensed([role]);

		// A user outside the project gets the same not-found as a missing project.
		const relation = await this.projectRelationRepository.findRelation(projectId, userId);
		if (!relation) {
			throw new NotFoundError(`Could not find project with ID: ${projectId}`);
		}

		await this.projectRelationRepository.upsertRelation(projectId, userId, role);
	}

	async deleteUserFromProject(projectId: string, userId: string): Promise<void> {
		this.assertTeamProject(await this.getProject(projectId));
		const relation = await this.projectRelationRepository.findRelation(projectId, userId);
		if (!relation) return;

		if (relation.role.slug === PROJECT_OWNER_ROLE_SLUG) {
			throw new ForbiddenError('Project owner cannot be removed from the project');
		}

		await this.projectRelationRepository.removeRelation(projectId, userId);
	}

	// ----------------------------------
	//            lifecycle
	// ----------------------------------

	async createTeamProject(
		user: User,
		data: CreateProjectDto,
		overrides?: {
			id?: string;
			description?: string | null;
			customTelemetryTags?: Array<{ key: string; value: string }>;
		},
	): Promise<Project> {
		const limit = this.licenseState.getMaxTeamProjects();
		const project = await this.projectRepository.createTeamProjectUnderLimit(
			{
				...(overrides?.id ? { id: overrides.id } : {}),
				name: data.name,
				icon: data.icon ?? null,
				description: overrides?.description ?? null,
				customTelemetryTags: overrides?.customTelemetryTags ?? [],
				type: 'team',
				creatorId: user.id,
			},
			limit === UNLIMITED_LICENSE_QUOTA ? -1 : limit,
		);
		if (!project) {
			throw new TeamProjectOverQuotaError(limit);
		}

		// The creator administers the project they created.
		await this.addUser(project.id, { userId: user.id, role: PROJECT_ADMIN_ROLE_SLUG });

		return project;
	}

	async updateProject(
		projectId: string,
		data: UpdateProjectDto & { relations?: RelationPayload[] },
	): Promise<void> {
		const project = await this.getProject(projectId);
		// Personal projects are fixed (name follows the owner): report them as
		// not found for editing purposes rather than editable.
		if (project.type !== 'team') {
			throw new NotFoundError(`Could not find project with ID: ${projectId}`);
		}

		await this.projectRepository.update(
			{ id: project.id },
			{
				...(data.name !== undefined ? { name: data.name } : {}),
				...(data.icon !== undefined ? { icon: data.icon } : {}),
				...(data.description !== undefined ? { description: data.description } : {}),
				...(data.customTelemetryTags !== undefined
					? { customTelemetryTags: data.customTelemetryTags }
					: {}),
			},
		);

		// The public API accepts a full membership set alongside the field update.
		if (data.relations !== undefined) {
			await this.syncProjectRelations(projectId, data.relations);
		}
	}

	/**
	 * Delete a team project. With `migrateToProject`, all owned resources move
	 * there first; otherwise they are deleted with the project.
	 */
	async deleteProject(
		user: User,
		projectId: string,
		{ migrateToProject }: { migrateToProject?: string } = {},
	): Promise<void> {
		if (migrateToProject === projectId) {
			throw new BadRequestError('Cannot migrate resources to the project being deleted');
		}

		const project = await this.getProject(projectId);
		if (project.type === 'personal') {
			throw new ForbiddenError('Personal projects cannot be deleted');
		}

		// Lazy imports: these services (transitively) inject ProjectService, so a
		// top-level import would create a module/DI cycle.
		const { OwnershipTransferService } = await import(
			'@/services/ownership-transfer/ownership-transfer.service.js'
		);

		if (migrateToProject) {
			// The caller must be able to create resources in the target project,
			// otherwise the transfer would smuggle resources past its access rules.
			const targetProject = await this.getProjectWithScope(user, migrateToProject, [
				'workflow:create',
				'credential:create',
			]);
			if (!targetProject) {
				throw new NotFoundError(`Could not find project to migrate to. ID: ${migrateToProject}`);
			}
			await Container.get(OwnershipTransferService).transferAllResources(
				[project.id],
				migrateToProject,
			);
		} else {
			const { WorkflowService } = await import('@/workflows/workflow.service.js');
			const { CredentialsService } = await import('@/credentials/credentials.service.js');

			const [ownedSharedWorkflows, ownedSharedCredentials] = await Promise.all([
				this.sharedWorkflowRepository.find({
					select: { workflowId: true },
					where: { projectId: project.id, role: 'workflow:owner' },
				}),
				this.sharedCredentialsRepository.find({
					select: { credentialsId: true },
					where: { projectId: project.id, role: 'credential:owner' },
				}),
			]);

			const workflowService = Container.get(WorkflowService);
			for (const { workflowId } of ownedSharedWorkflows) {
				await workflowService.delete(user, workflowId, true);
			}

			const credentialsService = Container.get(CredentialsService);
			for (const { credentialsId } of ownedSharedCredentials) {
				await credentialsService.delete(user, credentialsId);
			}

			// Module-owned resources (e.g. data tables with physical user tables)
			// must be cleaned up explicitly — the FK cascade would orphan them.
			await Container.get(OwnershipTransferService).deleteModuleOwnedResources([project.id]);
		}

		await this.projectRelationRepository.delete({ projectId: project.id });
		await this.projectRepository.delete({ id: project.id });
	}

	// ----------------------------------
	//             helpers
	// ----------------------------------

	/** @throws {UnlicensedProjectRoleError} when a role is not licensed on this instance. */
	private checkRolesLicensed(roles: string[]) {
		for (const role of new Set(roles)) {
			if (!this.roleService.isRoleLicensed(role)) {
				throw new UnlicensedProjectRoleError(role);
			}
		}
	}

	/**
	 * License-check only the roles a membership change would newly grant —
	 * re-asserting a role a member already holds must not require a license
	 * (e.g. keeping an existing admin during a re-add or a provisioning sync).
	 */
	private async checkChangedRolesLicensed(projectId: string, relations: RelationPayload[]) {
		const existingRelations =
			await this.projectRelationRepository.getRelationsForProject(projectId);
		const currentRoleByUserId = new Map(
			existingRelations.map((relation) => [relation.userId, relation.role.slug]),
		);
		this.checkRolesLicensed(
			relations
				.filter((relation) => currentRoleByUserId.get(relation.userId) !== relation.role)
				.map((relation) => relation.role),
		);
	}
}
