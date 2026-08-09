import { Service } from '@n8n/di';
import { PROJECT_OWNER_ROLE_SLUG, type ProjectRole } from '@n8n/permissions';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { EntityManager } from '@n8n/typeorm';

import { ProjectRelation } from '../entities';

@Service()
export class ProjectRelationRepository extends Repository<ProjectRelation> {
	constructor(dataSource: DataSource) {
		super(ProjectRelation, dataSource.manager);
	}

	async getPersonalProjectOwners(projectIds: string[]) {
		return await this.find({
			where: {
				projectId: In(projectIds),
				role: { slug: PROJECT_OWNER_ROLE_SLUG },
			},
			relations: {
				user: {
					role: true,
				},
			},
		});
	}

	async getPersonalProjectsForUsers(userIds: string[]) {
		const projectRelations = await this.find({
			where: {
				userId: In(userIds),
				role: { slug: PROJECT_OWNER_ROLE_SLUG },
			},
		});

		return projectRelations.map((pr) => pr.projectId);
	}

	async getAccessibleProjectsByRoles(userId: string, roles: string[], trx?: EntityManager) {
		const em = trx ?? this.manager;
		const projectRelations = await em.find(ProjectRelation, {
			where: { userId, role: { slug: In(roles) } },
		});

		return projectRelations.map((pr) => pr.projectId);
	}

	/** The user's relation in a project, with its role (and the role's scopes) loaded. */
	async findRelation(projectId: string, userId: string) {
		return await this.findOne({
			where: { projectId, userId },
			relations: { role: true },
		});
	}

	/** All member relations of a project, with users and roles loaded. */
	async getRelationsForProject(projectId: string) {
		return await this.find({
			where: { projectId },
			relations: { user: true, role: true },
		});
	}

	/** All project relations of a user, with projects and roles loaded. */
	async getRelationsForUser(userId: string) {
		return await this.find({
			where: { userId },
			relations: { project: true, role: true },
		});
	}

	/** Create the relation, or update its role if the user is already a member. */
	async upsertRelation(projectId: string, userId: string, roleSlug: string) {
		await this.manager.upsert(ProjectRelation, { projectId, userId, role: { slug: roleSlug } }, [
			'projectId',
			'userId',
		]);
	}

	/** Atomically replace ALL member relations of a project with the given set. */
	async replaceAllRelationsForProject(
		projectId: string,
		relations: Array<{ userId: string; role: string }>,
	) {
		await this.manager.transaction(async (em) => {
			await em.delete(ProjectRelation, { projectId });
			await em.insert(
				ProjectRelation,
				relations.map(({ userId, role }) => ({ projectId, userId, role: { slug: role } })),
			);
		});
	}

	/** Remove a user's relation from a project. */
	async removeRelation(projectId: string, userId: string) {
		await this.delete({ projectId, userId });
	}

	/**
	 * Apply an SSO provisioning outcome to one user's memberships in a single
	 * transaction. Only the listed projects are touched, so other members and
	 * the user's memberships outside the provisioned surface — personal projects
	 * included — are left exactly as they were.
	 */
	async applyProvisionedRelationsForUser(
		userId: string,
		assignments: Array<{ projectId: string; roleSlug: string }>,
		removedProjectIds: string[],
	): Promise<void> {
		if (assignments.length === 0 && removedProjectIds.length === 0) return;

		await this.manager.transaction(async (em) => {
			if (removedProjectIds.length > 0) {
				await em.delete(ProjectRelation, { userId, projectId: In(removedProjectIds) });
			}
			for (const { projectId, roleSlug } of assignments) {
				await em.upsert(ProjectRelation, { projectId, userId, role: { slug: roleSlug } }, [
					'projectId',
					'userId',
				]);
			}
		});
	}

	/**
	 * Find the role of a user in a project.
	 */
	async findProjectRole({ userId, projectId }: { userId: string; projectId: string }) {
		const relation = await this.findOneBy({ projectId, userId });

		return relation?.role ?? null;
	}

	/** Counts the number of users in each role, e.g. `{ admin: 2, member: 6, owner: 1 }` */
	async countUsersByRole() {
		const rows = (await this.createQueryBuilder()
			.select(['role', 'COUNT(role) as count'])
			.groupBy('role')
			.execute()) as Array<{ role: ProjectRole; count: string }>;
		return rows.reduce(
			(acc, row) => {
				acc[row.role] = parseInt(row.count, 10);
				return acc;
			},
			{} as Record<ProjectRole, number>,
		);
	}

	async findUserIdsByProjectId(projectId: string): Promise<string[]> {
		const rows = await this.find({
			select: ['userId'],
			where: { projectId },
		});

		return [...new Set(rows.map((r) => r.userId))];
	}

	async findAllByUser(userId: string) {
		return await this.find({
			where: {
				userId,
			},
			relations: { role: true },
		});
	}
}
