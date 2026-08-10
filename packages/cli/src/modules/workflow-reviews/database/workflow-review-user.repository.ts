import { ProjectRelation, SharedWorkflow, User } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

/**
 * Reads the users who hold a given workflow scope, for the eligible-reviewers
 * endpoint. Lives in the module's persistence layer so the service never names a
 * TypeORM type; role slugs come in already resolved from scopes, so a project
 * setting that strips `workflow:publish` from a role is honoured rather than
 * second-guessed by a role-name check.
 */
@Service()
export class WorkflowReviewUserRepository extends Repository<User> {
	constructor(dataSource: DataSource) {
		super(User, dataSource.manager);
	}

	async findUsersWithWorkflowScope({
		workflowId,
		projectRoleSlugs,
		workflowRoleSlugs,
		globalRoleSlugs,
	}: {
		workflowId: string;
		projectRoleSlugs: string[];
		workflowRoleSlugs: string[];
		globalRoleSlugs: string[];
	}): Promise<User[]> {
		const byWorkflowAccess =
			projectRoleSlugs.length > 0 && workflowRoleSlugs.length > 0
				? await this.createQueryBuilder('user')
						.innerJoin(ProjectRelation, 'pr', 'pr.userId = user.id')
						.innerJoin(SharedWorkflow, 'sw', 'sw.projectId = pr.projectId')
						.where('sw.workflowId = :workflowId', { workflowId })
						.andWhere('sw.role IN (:...workflowRoleSlugs)', { workflowRoleSlugs })
						.andWhere('pr.role IN (:...projectRoleSlugs)', { projectRoleSlugs })
						.getMany()
				: [];

		// Instance-level roles grant the scope on every workflow, so they are not
		// reachable through the sharing join above.
		const byGlobalRole =
			globalRoleSlugs.length > 0
				? await this.find({ where: { role: { slug: In(globalRoleSlugs) } } })
				: [];

		const byId = new Map<string, User>();
		for (const user of [...byWorkflowAccess, ...byGlobalRole]) {
			byId.set(user.id, user);
		}
		return [...byId.values()];
	}
}
