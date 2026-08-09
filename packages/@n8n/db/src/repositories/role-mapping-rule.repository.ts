import { Service } from '@n8n/di';
import { DataSource, In, Repository, type EntityManager } from '@n8n/typeorm';

import { Project, Role, RoleMappingRule } from '../entities';

/** Rule types the provisioning engine understands; ordering is type-local. */
export type RoleMappingRuleType = 'instance' | 'project';

export type RoleMappingRuleSortField = 'order' | 'createdAt' | 'updatedAt';

export interface RoleMappingRuleListOptions {
	type?: string;
	skip?: number;
	take?: number;
	sortBy?: RoleMappingRuleSortField;
	sortOrder?: 'ASC' | 'DESC';
}

export interface RoleMappingRuleFields {
	expression?: string;
	roleSlug?: string;
	type?: string;
	projectIds?: string[];
}

export interface CreateRoleMappingRuleInput {
	expression: string;
	roleSlug: string;
	type: string;
	/** Position within the type's order space; omitted or too high appends. */
	index?: number;
	projectIds?: string[];
}

/**
 * `UNIQUE(type, order)` is checked per row, so a compaction pass cannot shift
 * rows through values that are still occupied. Every reorder therefore parks the
 * affected rows in a disjoint negative range first, then writes the final
 * `0..n-1` sequence. The base sits far below any order the API accepts.
 */
const STAGING_ORDER_BASE = -2_000_000_000;

@Service()
export class RoleMappingRuleRepository extends Repository<RoleMappingRule> {
	constructor(dataSource: DataSource) {
		super(RoleMappingRule, dataSource.manager);
	}

	/** Rules of one type in evaluation order — first match wins. */
	async findByTypeInEvaluationOrder(type: string): Promise<RoleMappingRule[]> {
		return await this.find({
			where: { type },
			order: { order: 'ASC' },
			relations: ['role', 'projects'],
		});
	}

	async countByType(type: string): Promise<number> {
		return await this.count({ where: { type } });
	}

	async countByRoleSlug(roleSlug: string): Promise<number> {
		return await this.count({ where: { role: { slug: roleSlug } } });
	}

	async findRuleById(id: string): Promise<RoleMappingRule | null> {
		return await this.findOne({ where: { id }, relations: ['role', 'projects'] });
	}

	async listRules({
		type,
		skip,
		take,
		sortBy = 'order',
		sortOrder = 'ASC',
	}: RoleMappingRuleListOptions): Promise<{ count: number; items: RoleMappingRule[] }> {
		const [items, count] = await this.findAndCount({
			where: type ? { type } : {},
			order: { [sortBy]: sortOrder },
			skip,
			take,
			relations: ['role', 'projects'],
		});
		return { count, items };
	}

	async createRuleAtIndex(input: CreateRoleMappingRuleInput): Promise<string> {
		return await this.manager.transaction(async (trx) => {
			const existing = await this.loadOrderedIds(trx, input.type);
			const index = clampIndex(input.index, existing.length);

			const rule = trx.create(RoleMappingRule, {
				expression: input.expression,
				role: { slug: input.roleSlug },
				type: input.type,
				// Parked out of the way; the compaction pass below assigns the real order.
				order: STAGING_ORDER_BASE - existing.length - 1,
				projects: await this.resolveProjects(trx, input.projectIds),
			});
			const saved = await trx.save(rule);

			const ordered = [...existing];
			ordered.splice(index, 0, saved.id);
			await this.writeOrder(trx, ordered);

			return saved.id;
		});
	}

	/** Updates non-order fields. `type` changes move the rule to the end of the new type. */
	async updateRuleFields(id: string, fields: RoleMappingRuleFields): Promise<void> {
		await this.manager.transaction(async (trx) => {
			const rule = await trx.findOne(RoleMappingRule, { where: { id }, relations: ['projects'] });
			if (!rule) return;

			const previousType = rule.type;

			if (fields.expression !== undefined) rule.expression = fields.expression;
			// Only the FK column is written; the referenced role row is never touched.
			if (fields.roleSlug !== undefined) rule.role = trx.create(Role, { slug: fields.roleSlug });
			if (fields.projectIds !== undefined) {
				rule.projects = await this.resolveProjects(trx, fields.projectIds);
			}

			if (fields.type !== undefined && fields.type !== previousType) {
				rule.type = fields.type;
				const targetOrders = await this.loadOrderedIds(trx, fields.type);
				rule.order = STAGING_ORDER_BASE - targetOrders.length - 1;
				await trx.save(rule);

				await this.writeOrder(trx, [...targetOrders, id]);
				await this.writeOrder(
					trx,
					(await this.loadOrderedIds(trx, previousType)).filter((ruleId) => ruleId !== id),
				);
				return;
			}

			await trx.save(rule);
		});
	}

	/**
	 * Sets an explicit order. Returns `'conflict'` when another rule of the same
	 * type already occupies the (clamped) position — callers surface that as 409.
	 */
	async setRuleOrder(id: string, requestedOrder: number): Promise<'updated' | 'conflict'> {
		return await this.manager.transaction(async (trx) => {
			const rule = await trx.findOne(RoleMappingRule, { where: { id } });
			if (!rule) return 'conflict';

			const ordered = await this.loadOrderedIds(trx, rule.type);
			const target = clampIndex(Math.max(requestedOrder, 0), Math.max(ordered.length - 1, 0));
			if (rule.order === target) return 'updated';
			if (ordered.some((ruleId, position) => ruleId !== id && position === target)) {
				return 'conflict';
			}

			rule.order = target;
			await trx.save(rule);
			return 'updated';
		});
	}

	/** Moves a rule within its type and compacts the type's order space. */
	async moveRuleToIndex(id: string, targetIndex: number): Promise<void> {
		await this.manager.transaction(async (trx) => {
			const rule = await trx.findOne(RoleMappingRule, { where: { id } });
			if (!rule) return;

			const ordered = await this.loadOrderedIds(trx, rule.type);
			const current = ordered.indexOf(id);
			if (current === -1) return;

			ordered.splice(current, 1);
			ordered.splice(clampIndex(targetIndex, ordered.length), 0, id);
			await this.writeOrder(trx, ordered);
		});
	}

	async deleteRuleAndCompact(id: string): Promise<boolean> {
		return await this.manager.transaction(async (trx) => {
			const rule = await trx.findOne(RoleMappingRule, { where: { id } });
			if (!rule) return false;

			const { type } = rule;
			await trx.delete(RoleMappingRule, { id });
			await this.writeOrder(trx, await this.loadOrderedIds(trx, type));
			return true;
		});
	}

	/** Deletes every rule of one type, clearing that type's order space. */
	async deleteAllOfType(type: string): Promise<number> {
		return await this.manager.transaction(async (trx) => {
			const ids = await this.loadOrderedIds(trx, type);
			if (ids.length === 0) return 0;
			await trx.delete(RoleMappingRule, { id: In(ids) });
			return ids.length;
		});
	}

	private async loadOrderedIds(trx: EntityManager, type: string): Promise<string[]> {
		const rules = await trx.find(RoleMappingRule, {
			where: { type },
			order: { order: 'ASC', createdAt: 'ASC' },
			select: { id: true },
		});
		return rules.map((rule) => rule.id);
	}

	private async resolveProjects(trx: EntityManager, projectIds?: string[]): Promise<Project[]> {
		if (!projectIds || projectIds.length === 0) return [];
		return await trx.find(Project, { where: { id: In(projectIds) } });
	}

	/** Two-phase rewrite of one type's order space to a compact `0..n-1`. */
	private async writeOrder(trx: EntityManager, orderedIds: string[]): Promise<void> {
		for (const [index, id] of orderedIds.entries()) {
			await trx.update(RoleMappingRule, { id }, { order: STAGING_ORDER_BASE - index });
		}
		for (const [index, id] of orderedIds.entries()) {
			await trx.update(RoleMappingRule, { id }, { order: index });
		}
	}
}

function clampIndex(requested: number | undefined, max: number): number {
	if (requested === undefined || Number.isNaN(requested)) return max;
	if (requested < 0) return 0;
	return Math.min(requested, max);
}
