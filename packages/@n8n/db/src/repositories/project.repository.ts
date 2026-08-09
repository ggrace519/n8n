import { Service } from '@n8n/di';
import type { EntityManager, SelectQueryBuilder } from '@n8n/typeorm';
import { Brackets, DataSource, In, Repository } from '@n8n/typeorm';

import { Project } from '../entities';

@Service()
export class ProjectRepository extends Repository<Project> {
	constructor(dataSource: DataSource) {
		super(Project, dataSource.manager);
	}

	async getPersonalProjectForUser(userId: string, entityManager?: EntityManager) {
		const em = entityManager ?? this.manager;

		return await em.findOne(Project, {
			where: {
				type: 'personal',
				creatorId: userId,
			},
			relations: ['projectRelations.role'],
		});
	}

	async getPersonalProjectForUserOrFail(userId: string, entityManager?: EntityManager) {
		const em = entityManager ?? this.manager;

		return await em.findOneOrFail(Project, {
			where: {
				type: 'personal',
				creatorId: userId,
			},
		});
	}

	async getAccessibleProjects(userId: string) {
		return await this.find({
			where: {
				projectRelations: {
					userId,
				},
			},
		});
	}

	/**
	 * Create a team project only while the total team-project count is below
	 * `limit` (-1 = unlimited); returns null when the quota is exhausted.
	 * Count and insert share one transaction so parallel creations cannot
	 * overshoot the quota (fully serialized on SQLite; best-effort under
	 * concurrent Postgres transactions).
	 */
	async createTeamProjectUnderLimit(
		data: Pick<Project, 'name' | 'type'> & Partial<Project>,
		limit: number,
	): Promise<Project | null> {
		return await this.manager.transaction(async (em) => {
			if (limit !== -1) {
				const count = await em.count(Project, { where: { type: 'team' } });
				if (count >= limit) return null;
			}
			return await em.save(em.create(Project, data));
		});
	}

	/** Find a project by ID; supports running inside a caller's transaction. */
	async findById(projectId: string, entityManager?: EntityManager) {
		const em = entityManager ?? this.manager;
		return await em.findOneBy(Project, { id: projectId });
	}

	/**
	 * Find a project by ID, but only when the given user is a member of it
	 * through one of the given roles. Supports a caller's transaction.
	 */
	async findByIdForUserWithRoles(
		projectId: string,
		userId: string,
		roleSlugs: string[],
		entityManager?: EntityManager,
	) {
		if (roleSlugs.length === 0) return null;
		const em = entityManager ?? this.manager;
		return await em.findOne(Project, {
			where: {
				id: projectId,
				projectRelations: { userId, role: { slug: In(roleSlugs) } },
			},
		});
	}

	/** The subset of the given IDs that exist as projects. */
	async getExistingProjectIds(projectIds: string[]): Promise<string[]> {
		if (projectIds.length === 0) return [];
		const projects = await this.find({
			select: { id: true },
			where: { id: In(projectIds) },
		});
		return projects.map((project) => project.id);
	}

	/**
	 * Of the given IDs, the ones that name a team project. Used where a feature
	 * may only target shared projects — a personal project has exactly one owner
	 * and is not a membership surface.
	 */
	async getExistingTeamProjectIds(projectIds: string[]): Promise<string[]> {
		if (projectIds.length === 0) return [];
		const projects = await this.find({
			select: { id: true },
			where: { id: In(projectIds), type: 'team' },
		});
		return projects.map((project) => project.id);
	}

	/** Projects with the given IDs, ordered deterministically (createdAt, then id). */
	async findByIds(projectIds: string[]): Promise<Project[]> {
		if (projectIds.length === 0) return [];
		return await this.find({
			where: { id: In(projectIds) },
			order: { createdAt: 'ASC', id: 'ASC' },
		});
	}

	async getAccessibleProjectsByExactName(
		userId: string,
		name: string,
		type?: 'personal' | 'team',
	): Promise<Project[]> {
		const idsQuery = this.createQueryBuilder('p')
			.select('p.id', 'id')
			.innerJoin('p.projectRelations', 'pr')
			.where('pr.userId = :userId', { userId })
			.andWhere('LOWER(p.name) = LOWER(:name)', { name });

		if (type) {
			idsQuery.andWhere('p.type = :type', { type });
		}

		const query = this.createQueryBuilder('project')
			.leftJoin('project.creator', 'creator')
			.where(`project.id IN (${idsQuery.getQuery()})`)
			.setParameters(idsQuery.getParameters());
		this.applyActivationOrder(query);

		return await query.getMany();
	}

	async findAllProjectsAndCount(options: ProjectListOptions): Promise<[Project[], number]> {
		const query = this.createQueryBuilder('project').leftJoin('project.creator', 'creator');

		this.applyFilters(query, options);
		this.applyActivationOrder(query);
		this.applyPagination(query, options);

		return await query.getManyAndCount();
	}

	// Strict semantics: returns only projects the user has a relation to
	// (their personal project + projects they are explicitly a member of).
	// Do not broaden — peer-personal-project discovery for the share modal lives
	// in `getShareableProjectsAndCount` below; conflating the two has regressed
	// the share dropdown before (see IAM-591).
	async getAccessibleProjectsAndCount(
		userId: string,
		options: ProjectListOptions,
	): Promise<[Project[], number]> {
		const idsQuery = this.createQueryBuilder('p')
			.select('p.id', 'id')
			.innerJoin('p.projectRelations', 'pr')
			.where('pr.userId = :userId', { userId });

		this.applyIdsQueryFilters(idsQuery, options);
		return await this.runProjectListByIdsQuery(idsQuery, options);
	}

	// Wide semantics: returns peer personal projects in addition to projects
	// the user has a relation to. Used only by the sharing-discovery endpoint
	// (`GET /rest/projects/sharing-candidates`) so the workflow / credential
	// share dropdowns can list other users as share targets.
	async getShareableProjectsAndCount(
		userId: string,
		options: ProjectListOptions,
	): Promise<[Project[], number]> {
		// DISTINCT + LEFT JOIN avoids duplicate rows from the relation join
		// while still allowing personal projects with no caller relation to match.
		const idsQuery = this.createQueryBuilder('p')
			.select('DISTINCT p.id', 'id')
			.leftJoin('p.projectRelations', 'pr')
			.where(
				new Brackets((qb) => {
					qb.where('p.type = :personalType', { personalType: 'personal' }).orWhere(
						'pr.userId = :userId',
						{ userId },
					);
				}),
			);

		this.applyIdsQueryFilters(idsQuery, options);
		return await this.runProjectListByIdsQuery(idsQuery, options);
	}

	private applyIdsQueryFilters(
		idsQuery: SelectQueryBuilder<Project>,
		options: ProjectListOptions,
	): void {
		if (options.search) {
			idsQuery.andWhere('LOWER(p.name) LIKE LOWER(:search)', {
				search: `%${options.search}%`,
			});
		}

		if (options.type) {
			idsQuery.andWhere('p.type = :type', { type: options.type });
		}

		if (options.activated === true) {
			idsQuery.leftJoin('p.creator', 'creator').andWhere(
				new Brackets((qb) => {
					qb.where('p.type != :personalTypeFilter', {
						personalTypeFilter: 'personal',
					}).orWhere('creator.password IS NOT NULL');
				}),
			);
		}
	}

	private async runProjectListByIdsQuery(
		idsQuery: SelectQueryBuilder<Project>,
		options: ProjectListOptions,
	): Promise<[Project[], number]> {
		const query = this.createQueryBuilder('project')
			.leftJoin('project.creator', 'creator')
			.where(`project.id IN (${idsQuery.getQuery()})`);
		query.setParameters(idsQuery.getParameters());

		// Sort: team projects first, then activated personal projects, then pending ones
		this.applyActivationOrder(query);
		this.applyPagination(query, options);

		return await query.getManyAndCount();
	}

	private applyFilters(query: SelectQueryBuilder<Project>, options: ProjectListOptions): void {
		if (options.search) {
			query.andWhere('LOWER(project.name) LIKE LOWER(:search)', {
				search: `%${options.search}%`,
			});
		}

		if (options.type) {
			query.andWhere('project.type = :type', { type: options.type });
		}

		if (options.activated === true) {
			query.andWhere(
				new Brackets((qb) => {
					qb.where('project.type != :personalTypeFilter', {
						personalTypeFilter: 'personal',
					}).orWhere('creator.password IS NOT NULL');
				}),
			);
		}
	}

	/**
	 * Sort: team projects first, then activated personal projects, then pending ones.
	 * Uses addSelect + alias so TypeORM doesn't try to parse the CASE as a property path.
	 * The `creator` relation must already be joined on the query.
	 */
	private applyActivationOrder(query: SelectQueryBuilder<Project>): void {
		query
			.addSelect(
				"CASE WHEN project.type != 'personal' THEN 0 WHEN creator.password IS NOT NULL THEN 1 ELSE 2 END",
				'activation_order',
			)
			.orderBy('activation_order', 'ASC')
			.addOrderBy('project.name', 'ASC');
	}

	private applyPagination(query: SelectQueryBuilder<Project>, options: ProjectListOptions): void {
		query.skip(options.skip ?? 0);
		if (options.take !== undefined) {
			query.take(options.take);
		}
	}

	async getProjectCounts() {
		return {
			personal: await this.count({ where: { type: 'personal' } }),
			team: await this.count({ where: { type: 'team' } }),
		};
	}
}

export interface ProjectListOptions {
	skip?: number;
	take?: number;
	search?: string;
	type?: 'personal' | 'team';
	activated?: boolean;
}
