import type { CreateVariableRequestDto, UpdateVariableRequestDto } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import type { User, Variables } from '@n8n/db';
import { VariablesRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { VariableCountLimitReachedError } from '@/errors/variable-count-limit-reached.error';
import { userHasScopes } from '@/permissions/check-access';
import { ProjectScopeService } from '@/permissions/project-scope.service';
import { CacheService } from '@/services/cache/cache.service';

const VARIABLES_CACHE_KEY = 'variables';

@Service()
export class VariablesService {
	constructor(
		private readonly cacheService: CacheService,
		private readonly variablesRepository: VariablesRepository,
		private readonly licenseState: LicenseState,
		private readonly projectScopeService: ProjectScopeService,
	) {}

	/**
	 * All variables (global + project-scoped, with their project relation),
	 * served from the shared cache. Workflow executions read this on every run.
	 */
	async getAllCached(state?: 'empty'): Promise<Variables[]> {
		const cached = await this.cacheService.get<Variables[]>(VARIABLES_CACHE_KEY, {
			refreshFn: async () => await this.findAll(),
		});
		const variables = cached ?? [];
		return state === 'empty' ? variables.filter((v) => v.value === '') : variables;
	}

	/** A single cached variable, or null. No access filtering — internal use. */
	async getCached(id: string): Promise<Variables | null> {
		const variables = await this.getAllCached();
		return variables.find((variable) => variable.id === id) ?? null;
	}

	/**
	 * The variables visible to the user: global variables plus the variables
	 * of projects where the user's role grants `projectVariable:read` (all
	 * projects for users whose global role grants it). `projectId` narrows to
	 * one project (`null` = global variables only).
	 */
	async getAllForUser(
		user: User,
		options: { state?: 'empty'; projectId?: string | null } = {},
	): Promise<Variables[]> {
		let variables = await this.getAllCached(options.state);

		if (options.projectId !== undefined) {
			variables =
				options.projectId === null
					? variables.filter((variable) => !variable.project)
					: variables.filter((variable) => variable.project?.id === options.projectId);
		}

		const projectIds = await this.projectScopeService.getProjectIds(user, ['projectVariable:read']);
		if (projectIds === null) return variables;

		const accessible = new Set(projectIds);
		return variables.filter((variable) => !variable.project || accessible.has(variable.project.id));
	}

	/** Reload all variables from the database into the shared cache. */
	async updateCache(): Promise<void> {
		const variables = await this.findAll();
		await this.cacheService.set(VARIABLES_CACHE_KEY, variables);
	}

	/**
	 * The instance-wide variable quota: `null` when unlimited, otherwise the
	 * licensed limit and how many more rows fit (bounded at zero). Global and
	 * project variables share the same quota.
	 */
	async getRemainingVariableQuota(): Promise<{ limit: number; remaining: number } | null> {
		const limit = this.licenseState.getMaxVariables();
		if (limit === UNLIMITED_LICENSE_QUOTA) return null;

		const count = await this.variablesRepository.count();
		return { limit, remaining: Math.max(limit - count, 0) };
	}

	async create(user: User, variable: CreateVariableRequestDto): Promise<Variables> {
		const targetProjectId = variable.projectId ?? null;
		await this.checkCanWrite(user, targetProjectId, 'create');

		const quota = await this.getRemainingVariableQuota();
		if (quota !== null && quota.remaining <= 0) {
			throw new VariableCountLimitReachedError('Variables limit reached');
		}

		// Same error type as the quota failure — consumers that race concurrent
		// creates (the package importer) catch it and re-check the destination.
		if (await this.variablesRepository.keyInUse(variable.key, targetProjectId)) {
			throw new VariableCountLimitReachedError(
				`A variable with key "${variable.key}" already exists at this destination`,
			);
		}

		const saved = await this.variablesRepository.save(
			this.variablesRepository.create({
				key: variable.key,
				type: variable.type ?? 'string',
				value: variable.value,
				project: targetProjectId ? { id: targetProjectId } : null,
			}),
		);
		await this.updateCache();
		return saved;
	}

	async update(user: User, id: string, variable: UpdateVariableRequestDto): Promise<Variables> {
		const existing = await this.variablesRepository.findOne({
			where: { id },
			relations: ['project'],
		});
		if (!existing) {
			throw new NotFoundError(`Variable with ID "${id}" could not be found`);
		}

		const currentProjectId = existing.project?.id ?? null;
		const targetProjectId =
			variable.projectId === undefined ? currentProjectId : variable.projectId;
		await this.checkCanWrite(user, targetProjectId, 'update');

		const targetKey = variable.key ?? existing.key;
		const destinationChanged = targetKey !== existing.key || targetProjectId !== currentProjectId;
		if (
			destinationChanged &&
			(await this.variablesRepository.keyInUse(targetKey, targetProjectId, id))
		) {
			throw new VariableCountLimitReachedError(
				`A variable with key "${targetKey}" already exists at this destination`,
			);
		}

		await this.variablesRepository.save({
			id,
			key: targetKey,
			type: variable.type ?? existing.type,
			value: variable.value ?? existing.value,
			project: targetProjectId ? { id: targetProjectId } : null,
		});
		await this.updateCache();

		return (await this.variablesRepository.findOne({ where: { id }, relations: ['project'] }))!;
	}

	async delete(id: string): Promise<void> {
		await this.variablesRepository.delete(id);
		await this.updateCache();
	}

	async deleteByIds(ids: string[]): Promise<void> {
		await this.variablesRepository.deleteByIds(ids);
		await this.updateCache();
	}

	private async findAll(): Promise<Variables[]> {
		return await this.variablesRepository.find({ relations: ['project'] });
	}

	/** Global writes need the global `variable:*` scope; project writes need `projectVariable:*` in the target project. */
	private async checkCanWrite(user: User, projectId: string | null, op: 'create' | 'update') {
		if (projectId === null) {
			if (!(await userHasScopes(user, [`variable:${op}`], true, {}))) {
				throw new ForbiddenError(`You are not allowed to ${op} global variables`);
			}
		} else if (!(await userHasScopes(user, [`projectVariable:${op}`], false, { projectId }))) {
			throw new ForbiddenError(`You are not allowed to ${op} variables in this project`);
		}
	}
}
