import type {
	CreateRoleMappingRuleDto,
	ListRoleMappingRuleQueryDto,
	PatchRoleMappingRuleDto,
} from '@n8n/api-types';
import type { RoleMappingRule, User } from '@n8n/db';
import { ProjectRepository, RoleMappingRuleRepository, RoleRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EventService } from '@/events/event.service';

import { PROJECT_RULE_TYPE } from './constants';

export interface RoleMappingRuleResponse {
	id: string;
	expression: string;
	role: string;
	type: string;
	order: number;
	projectIds: string[];
	createdAt: Date;
	updatedAt: Date;
}

type RuleType = 'instance' | 'project';

const PATCHABLE_FIELDS = ['expression', 'role', 'type', 'order', 'projectIds'] as const;

/**
 * CRUD for role-mapping rules. Ordering is type-local and always compact, so
 * the engine can read a rule list and stop at the first match.
 */
@Service()
export class RoleMappingRuleService {
	constructor(
		private readonly roleMappingRuleRepository: RoleMappingRuleRepository,
		private readonly roleRepository: RoleRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly eventService: EventService,
	) {}

	async list(query: ListRoleMappingRuleQueryDto): Promise<{
		count: number;
		items: RoleMappingRuleResponse[];
	}> {
		const [sortBy, sortOrder] = (query.sortBy ?? 'order:asc').split(':');
		const { count, items } = await this.roleMappingRuleRepository.listRules({
			type: query.type,
			skip: query.skip,
			take: query.take,
			sortBy: toSortField(sortBy),
			sortOrder: sortOrder === 'desc' ? 'DESC' : 'ASC',
		});
		return { count, items: items.map(toResponse) };
	}

	async create(payload: CreateRoleMappingRuleDto, actor: User): Promise<RoleMappingRuleResponse> {
		this.assertProjectRuleHasProjects(payload.type, payload.projectIds);
		await this.assertProjectsAreTeamProjects(payload.projectIds);
		await this.assertRoleExists(payload.role);

		const id = await this.roleMappingRuleRepository.createRuleAtIndex({
			expression: payload.expression,
			roleSlug: payload.role,
			type: payload.type,
			index: payload.order,
			projectIds: payload.projectIds,
		});

		this.eventService.emit('role-mapping-rule-created', {
			user: actor,
			ruleId: id,
			ruleType: payload.type,
			expression: payload.expression,
			role: payload.role,
		});

		return await this.getOrFail(id);
	}

	async patch(
		id: string,
		payload: PatchRoleMappingRuleDto,
		actor: User,
	): Promise<RoleMappingRuleResponse> {
		const patchedFields = PATCHABLE_FIELDS.filter((field) => payload[field] !== undefined);
		if (patchedFields.length === 0) {
			throw new BadRequestError('The request body must contain at least one field to update');
		}

		const existing = await this.findOrFail(id);
		const targetType = payload.type ?? existing.type;
		if (payload.type !== undefined || payload.projectIds !== undefined) {
			this.assertProjectRuleHasProjects(
				targetType,
				payload.projectIds ?? existing.projects?.map((project) => project.id),
			);
		}
		await this.assertProjectsAreTeamProjects(payload.projectIds);
		if (payload.role !== undefined) await this.assertRoleExists(payload.role);

		await this.roleMappingRuleRepository.updateRuleFields(id, {
			expression: payload.expression,
			roleSlug: payload.role,
			type: payload.type,
			projectIds: payload.projectIds,
		});

		if (payload.order !== undefined) {
			const outcome = await this.roleMappingRuleRepository.setRuleOrder(id, payload.order);
			if (outcome === 'conflict') {
				throw new ConflictError(
					`A rule with order ${payload.order} already exists for type "${targetType}"`,
				);
			}
		}

		this.eventService.emit('role-mapping-rule-updated', {
			user: actor,
			ruleId: id,
			ruleType: toRuleType(targetType),
			patchedFields,
		});

		return await this.getOrFail(id);
	}

	async move(id: string, targetIndex: number, actor: User): Promise<RoleMappingRuleResponse> {
		const existing = await this.findOrFail(id);
		await this.roleMappingRuleRepository.moveRuleToIndex(id, targetIndex);

		this.eventService.emit('role-mapping-rule-updated', {
			user: actor,
			ruleId: id,
			ruleType: toRuleType(existing.type),
			patchedFields: ['order'],
		});

		return await this.getOrFail(id);
	}

	async delete(id: string, actor: User): Promise<{ success: true }> {
		const existing = await this.findOrFail(id);
		await this.roleMappingRuleRepository.deleteRuleAndCompact(id);

		this.eventService.emit('role-mapping-rule-deleted', {
			user: actor,
			ruleId: id,
			ruleType: toRuleType(existing.type),
		});

		return { success: true };
	}

	private assertProjectRuleHasProjects(type: string, projectIds: string[] | undefined): void {
		if (type !== PROJECT_RULE_TYPE) return;
		if (projectIds && projectIds.length > 0) return;
		throw new BadRequestError('A project mapping rule requires at least one entry in projectIds');
	}

	/**
	 * Mapping rules may only target shared projects: a personal project has
	 * exactly one owner and is not a membership surface provisioning may write to.
	 */
	private async assertProjectsAreTeamProjects(projectIds: string[] | undefined): Promise<void> {
		if (!projectIds?.length) return;

		const requested = [...new Set(projectIds)];
		const teamProjects = await this.projectRepository.getExistingTeamProjectIds(requested);
		const unusable = requested.filter((projectId) => !teamProjects.includes(projectId));
		if (unusable.length === 0) return;

		throw new BadRequestError(
			`projectIds must reference existing team projects: ${unusable.join(', ')}`,
		);
	}

	private async assertRoleExists(slug: string): Promise<void> {
		const role = await this.roleRepository.findBySlug(slug);
		if (!role) throw new NotFoundError(`Could not find role with slug "${slug}"`);
	}

	private async findOrFail(id: string): Promise<RoleMappingRule> {
		const rule = await this.roleMappingRuleRepository.findRuleById(id);
		if (!rule) throw new NotFoundError(`Could not find role mapping rule with id "${id}"`);
		return rule;
	}

	private async getOrFail(id: string): Promise<RoleMappingRuleResponse> {
		return toResponse(await this.findOrFail(id));
	}
}

function toResponse(rule: RoleMappingRule): RoleMappingRuleResponse {
	return {
		id: rule.id,
		expression: rule.expression,
		role: rule.role.slug,
		type: rule.type,
		order: rule.order,
		projectIds: (rule.projects ?? []).map((project) => project.id),
		createdAt: rule.createdAt,
		updatedAt: rule.updatedAt,
	};
}

function toSortField(field: string | undefined): 'order' | 'createdAt' | 'updatedAt' {
	if (field === 'createdAt' || field === 'updatedAt') return field;
	return 'order';
}

function toRuleType(type: string): RuleType {
	return type === PROJECT_RULE_TYPE ? 'project' : 'instance';
}
