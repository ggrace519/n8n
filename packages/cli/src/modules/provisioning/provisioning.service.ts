import {
	BLOCK_ACCESS_ASSIGNMENT,
	ProvisioningConfigDto,
	type ProvisioningConfigPatchDto,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { RoleMappingRule, User } from '@n8n/db';
import {
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	RoleMappingRuleRepository,
	RoleRepository,
	SettingsRepository,
	UserRepository,
} from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { PROJECT_OWNER_ROLE_SLUG } from '@n8n/permissions';
import { jsonParse } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { EventService } from '@/events/event.service';

import {
	INSTANCE_RULE_TYPE,
	PROJECT_RULE_TYPE,
	PROVISIONING_PREFERENCES_DB_KEY,
} from './constants';
import {
	ProvisioningExpressionError,
	ProvisioningExpressionEvaluator,
} from './provisioning-expression-evaluator';
import type {
	ProvisioningApplicationResult,
	ProvisioningDecision,
	ProvisioningEvaluationInput,
	ProvisioningExpressionContext,
	ResolvedInstanceRole,
	ResolvedProjectRole,
} from './types';

/** Separator of a direct project-role claim entry: `<projectId>:<roleSlug>`. */
const PROJECT_CLAIM_SEPARATOR = ':';

/**
 * SSO role provisioning: owns the persisted policy, decides which roles a login
 * resolves to, and reconciles the account against that decision.
 *
 * The decision is always taken before any account is looked up or written, so a
 * policy that denies access — or one that cannot be evaluated — never leaves a
 * half-provisioned account behind.
 */
@Service()
export class ProvisioningService {
	/**
	 * The effective policy. Held as one mutable object so a reload swaps it
	 * atomically for every reader.
	 */
	private provisioningConfig: ProvisioningConfigDto | null = null;

	private initialized = false;

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly globalConfig: GlobalConfig,
		private readonly logger: Logger,
		private readonly roleMappingRuleRepository: RoleMappingRuleRepository,
		private readonly roleRepository: RoleRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly userRepository: UserRepository,
		private readonly expressionEvaluator: ProvisioningExpressionEvaluator,
		private readonly eventService: EventService,
	) {}

	/** Loads the initial policy. Idempotent — repeat calls are no-ops. */
	async init(): Promise<void> {
		if (this.initialized) return;
		await this.getProvisioningConfig();
		this.initialized = true;
	}

	async getProvisioningConfig(): Promise<ProvisioningConfigDto> {
		if (this.provisioningConfig) return this.provisioningConfig;

		const row = await this.settingsRepository.findByKey(PROVISIONING_PREFERENCES_DB_KEY);
		if (!row?.value) {
			this.provisioningConfig = this.disabledDefaults();
			return this.provisioningConfig;
		}

		try {
			const parsed = ProvisioningConfigDto.safeParse(jsonParse<Record<string, unknown>>(row.value));
			// A partial/invalid row must not half-enable provisioning.
			this.provisioningConfig = parsed.success ? parsed.data : this.disabledDefaults();
		} catch {
			this.logger.warn('Failed to parse stored SSO provisioning config, using disabled defaults');
			this.provisioningConfig = this.disabledDefaults();
		}
		return this.provisioningConfig;
	}

	/**
	 * Applies a partial update, persists the merged document, and tells the
	 * other main processes to reload it.
	 */
	async updateProvisioningConfig(
		patch: ProvisioningConfigPatchDto,
		actor: User,
	): Promise<ProvisioningConfigDto> {
		const current = await this.getProvisioningConfig();
		const defaults = this.disabledDefaults();
		const merged: ProvisioningConfigDto = { ...current };

		applyBoolean(merged, patch, 'scopesProvisionInstanceRole', defaults);
		applyBoolean(merged, patch, 'scopesProvisionProjectRoles', defaults);
		applyBoolean(merged, patch, 'scopesUseExpressionMapping', defaults);
		applyString(merged, patch, 'scopesName', defaults);
		applyString(merged, patch, 'scopesInstanceRoleClaimName', defaults);
		applyString(merged, patch, 'scopesProjectsRolesClaimName', defaults);

		if (patch.defaultInstanceRole === null) {
			delete merged.defaultInstanceRole;
		} else if (patch.defaultInstanceRole !== undefined) {
			await this.assertAssignableDefaultRole(patch.defaultInstanceRole);
			merged.defaultInstanceRole = patch.defaultInstanceRole;
		}

		if (patch.deleteProjectRules === true) {
			const count = await this.roleMappingRuleRepository.deleteAllOfType(PROJECT_RULE_TYPE);
			if (count > 0) {
				this.eventService.emit('role-mapping-rules-bulk-deleted', {
					ruleType: PROJECT_RULE_TYPE,
					count,
					reason: 'strategy-switch',
				});
			}
		}

		await this.settingsRepository.upsert(
			{
				key: PROVISIONING_PREFERENCES_DB_KEY,
				// The reader rejects partial rows, so the full document is stored.
				value: JSON.stringify(merged),
				loadOnStartup: true,
			},
			{ conflictPaths: ['key'] },
		);

		this.provisioningConfig = merged;
		this.logger.debug('SSO provisioning configuration updated', { userId: actor.id });
		await this.broadcastReload();

		return merged;
	}

	/** Drop the cached config so the next read reflects the stored row. */
	@OnPubSubEvent('reload-sso-provisioning-configuration', { instanceType: 'main' })
	async handleReloadSsoProvisioningConfiguration(): Promise<void> {
		this.provisioningConfig = null;
		await this.getProvisioningConfig();
	}

	/**
	 * Whether users' instance (global) roles are managed by SSO provisioning.
	 * Expression mapping only takes ownership once an instance rule exists.
	 */
	async isInstanceRoleManaged(): Promise<boolean> {
		const config = await this.getProvisioningConfig();
		if (config.scopesProvisionInstanceRole) return true;
		if (!config.scopesUseExpressionMapping) return false;
		return (await this.roleMappingRuleRepository.countByType(INSTANCE_RULE_TYPE)) > 0;
	}

	/** Whether project memberships/roles are managed by SSO provisioning. */
	async isProjectRoleManaged(): Promise<boolean> {
		const config = await this.getProvisioningConfig();
		if (config.scopesProvisionProjectRoles) return true;
		if (!config.scopesUseExpressionMapping) return false;
		return (await this.roleMappingRuleRepository.countByType(PROJECT_RULE_TYPE)) > 0;
	}

	// ----------------------------------
	//        policy evaluation
	// ----------------------------------

	/**
	 * Decides what a login is entitled to. Must be called before the account is
	 * looked up: a denial has to be able to stop the flow before any write.
	 */
	async resolveLoginProvisioning(
		input: ProvisioningEvaluationInput,
	): Promise<ProvisioningDecision> {
		const config = await this.getProvisioningConfig();

		let instanceRole: ResolvedInstanceRole | undefined;
		let projectRoles: ResolvedProjectRole[] = [];
		let managedProjectIds: string[] = [];

		try {
			if (config.scopesUseExpressionMapping) {
				const context = buildExpressionContext(input);
				instanceRole = await this.resolveInstanceRoleFromRules(context);
				const projects = await this.resolveProjectRolesFromRules(context);
				projectRoles = projects.assignments;
				managedProjectIds = projects.managedProjectIds;
			}

			if (!instanceRole && config.scopesProvisionInstanceRole) {
				instanceRole = await this.resolveInstanceRoleFromClaim(input.directClaims?.instanceRole);
			}

			if (projectRoles.length === 0 && config.scopesProvisionProjectRoles) {
				const claimed = await this.resolveProjectRolesFromClaims(input.directClaims?.projectRoles);
				projectRoles = claimed.assignments;
				managedProjectIds = [...new Set([...managedProjectIds, ...claimed.managedProjectIds])];
			}
		} catch (error) {
			// A configured rule that cannot be decided fails the login closed. Only
			// the rule id and the failure class are recorded — never claim values.
			if (error instanceof ProvisioningExpressionError) {
				this.logger.warn('SSO login denied: a role mapping rule could not be evaluated', {
					ruleId: error.ruleId,
					failure: error.failure,
					provider: input.provider,
				});
			} else {
				this.logger.error('SSO login denied: role provisioning evaluation failed', {
					provider: input.provider,
				});
			}
			return { outcome: 'deny', reason: 'evaluation-failed' };
		}

		if (!instanceRole) {
			const fallback = this.resolveDefaultInstanceRole(config);
			if (fallback === 'deny') return { outcome: 'deny', reason: 'block-access' };
			instanceRole = fallback;
		}

		return {
			outcome: 'allow',
			provider: input.provider,
			instanceRole,
			projectRoles,
			managedProjectIds,
		};
	}

	/**
	 * Reconciles the account against an allow decision. Revocations are written
	 * before grants, so an interrupted apply can only ever reduce access.
	 */
	async applyLoginProvisioning(
		user: User,
		decision: ProvisioningDecision,
	): Promise<ProvisioningApplicationResult> {
		const unchanged: ProvisioningApplicationResult = {
			instanceRoleChanged: false,
			projectsAdded: 0,
			projectsRemoved: 0,
		};
		if (decision.outcome !== 'allow') return unchanged;

		const previousInstanceRole = user.role?.slug ?? null;
		const targetInstanceRole = decision.instanceRole?.roleSlug;
		// The instance owner is never re-assigned: an instance must keep its owner.
		const instanceRoleChanged =
			targetInstanceRole !== undefined &&
			previousInstanceRole !== GLOBAL_OWNER_ROLE.slug &&
			targetInstanceRole !== previousInstanceRole;

		const relations = await this.projectRelationRepository.getRelationsForUser(user.id);
		const previousProjectRoles = new Map(
			relations.map((relation) => [relation.projectId, relation.role?.slug ?? null]),
		);

		const managed = new Set(decision.managedProjectIds);
		const assigned = new Set(decision.projectRoles.map(({ projectId }) => projectId));
		const removedProjectIds = relations
			.filter(
				(relation) =>
					managed.has(relation.projectId) &&
					!assigned.has(relation.projectId) &&
					// Personal projects and ownership are outside the provisioned surface.
					relation.project?.type !== 'personal' &&
					relation.role?.slug !== PROJECT_OWNER_ROLE_SLUG,
			)
			.map((relation) => relation.projectId);

		const assignments = decision.projectRoles.map(({ projectId, roleSlug }) => ({
			projectId,
			roleSlug,
		}));
		const projectsAdded = decision.projectRoles.filter(
			({ projectId, roleSlug }) => previousProjectRoles.get(projectId) !== roleSlug,
		).length;

		await this.projectRelationRepository.applyProvisionedRelationsForUser(
			user.id,
			assignments,
			removedProjectIds,
		);

		if (instanceRoleChanged && targetInstanceRole !== undefined) {
			await this.userRepository.updateGlobalRole(user.id, targetInstanceRole);
		}

		this.emitProvisioningEvents(user, decision, {
			previousInstanceRole,
			instanceRoleChanged,
			previousProjectRoles,
			removedProjectIds,
			projectsAdded,
			expressionMappingActive: (await this.getProvisioningConfig()).scopesUseExpressionMapping,
		});

		return { instanceRoleChanged, projectsAdded, projectsRemoved: removedProjectIds.length };
	}

	// ----------------------------------
	//        resolution internals
	// ----------------------------------

	private async resolveInstanceRoleFromRules(
		context: ProvisioningExpressionContext,
	): Promise<ResolvedInstanceRole | undefined> {
		const rules =
			await this.roleMappingRuleRepository.findByTypeInEvaluationOrder(INSTANCE_RULE_TYPE);

		for (const rule of rules) {
			if (!(await this.matches(rule, context))) continue;
			return {
				roleSlug: rule.role.slug,
				matchedRuleId: rule.id,
				expression: rule.expression,
				isFallback: false,
			};
		}
		return undefined;
	}

	/**
	 * Project rules resolve per target project: the first matching rule that
	 * links a project decides that project's role, so one login can draw
	 * different projects from different rules.
	 */
	private async resolveProjectRolesFromRules(context: ProvisioningExpressionContext): Promise<{
		assignments: ResolvedProjectRole[];
		managedProjectIds: string[];
	}> {
		const rules =
			await this.roleMappingRuleRepository.findByTypeInEvaluationOrder(PROJECT_RULE_TYPE);

		const managedProjectIds = new Set<string>();
		const assignments: ResolvedProjectRole[] = [];
		const decided = new Set<string>();

		for (const rule of rules) {
			const projectIds = (rule.projects ?? []).map((project) => project.id);
			for (const projectId of projectIds) managedProjectIds.add(projectId);

			if (!(await this.matches(rule, context))) continue;

			for (const projectId of projectIds) {
				if (decided.has(projectId)) continue;
				decided.add(projectId);
				assignments.push({
					projectId,
					roleSlug: rule.role.slug,
					matchedRuleId: rule.id,
					expression: rule.expression,
				});
			}
		}

		return { assignments, managedProjectIds: [...managedProjectIds] };
	}

	private async matches(
		rule: RoleMappingRule,
		context: ProvisioningExpressionContext,
	): Promise<boolean> {
		return await this.expressionEvaluator.evaluate(rule.id, rule.expression, context);
	}

	/** Direct claim → instance role. An unusable claim assigns nothing. */
	private async resolveInstanceRoleFromClaim(
		claimed: string | undefined,
	): Promise<ResolvedInstanceRole | undefined> {
		if (!claimed) return undefined;

		const role = await this.roleRepository.findBySlug(claimed);
		if (!role || role.roleType !== 'global' || role.slug === GLOBAL_OWNER_ROLE.slug) {
			this.logger.warn('SSO instance-role claim ignored: not an assignable global role');
			return undefined;
		}
		return { roleSlug: role.slug, matchedRuleId: null, expression: null, isFallback: false };
	}

	/**
	 * Direct claim → project roles. Entries are `<projectId>:<roleSlug>`;
	 * unparsable entries and unknown projects/roles are skipped rather than
	 * denying the login, because the IdP owns that document's shape.
	 */
	private async resolveProjectRolesFromClaims(claimed: string[] | undefined): Promise<{
		assignments: ResolvedProjectRole[];
		managedProjectIds: string[];
	}> {
		if (!claimed?.length) return { assignments: [], managedProjectIds: [] };

		const assignments: ResolvedProjectRole[] = [];
		const managedProjectIds = new Set<string>();

		for (const entry of claimed) {
			// Role slugs contain a colon and project ids do not, so the first
			// separator ends the project id and the remainder is the whole slug.
			const separator = entry.indexOf(PROJECT_CLAIM_SEPARATOR);
			if (separator <= 0) continue;

			const projectId = entry.slice(0, separator);
			const roleSlug = entry.slice(separator + 1);
			const role = await this.roleRepository.findBySlug(roleSlug);
			if (!role || role.roleType !== 'project' || role.slug === PROJECT_OWNER_ROLE_SLUG) continue;

			managedProjectIds.add(projectId);
			if (assignments.some((assignment) => assignment.projectId === projectId)) continue;
			assignments.push({ projectId, roleSlug, matchedRuleId: '', expression: '' });
		}

		return { assignments, managedProjectIds: [...managedProjectIds] };
	}

	/**
	 * What happens when nothing matched: the configured default condition, else
	 * the legacy behaviour — `global:member` under expression mapping, and no
	 * instance-role change at all under direct-claim provisioning.
	 */
	private resolveDefaultInstanceRole(
		config: ProvisioningConfigDto,
	): ResolvedInstanceRole | undefined | 'deny' {
		if (config.defaultInstanceRole === BLOCK_ACCESS_ASSIGNMENT) return 'deny';
		if (config.defaultInstanceRole !== undefined) {
			return {
				roleSlug: config.defaultInstanceRole,
				matchedRuleId: null,
				expression: null,
				isFallback: true,
			};
		}
		if (config.scopesUseExpressionMapping) {
			return {
				roleSlug: GLOBAL_MEMBER_ROLE.slug,
				matchedRuleId: null,
				expression: null,
				isFallback: true,
			};
		}
		return undefined;
	}

	private emitProvisioningEvents(
		user: User,
		decision: Extract<ProvisioningDecision, { outcome: 'allow' }>,
		summary: {
			previousInstanceRole: string | null;
			instanceRoleChanged: boolean;
			previousProjectRoles: Map<string, string | null>;
			removedProjectIds: string[];
			projectsAdded: number;
			expressionMappingActive: boolean;
		},
	): void {
		if (summary.instanceRoleChanged && decision.instanceRole) {
			this.eventService.emit('sso-user-instance-role-updated', {
				role: decision.instanceRole.roleSlug,
				userId: user.id,
			});
		}

		if (summary.projectsAdded > 0 || summary.removedProjectIds.length > 0) {
			this.eventService.emit('sso-user-project-access-updated', {
				projectsAdded: summary.projectsAdded,
				projectsRemoved: summary.removedProjectIds.length,
				userId: user.id,
			});
		}

		// The pinned shape carries `isFallback` and a nullable `matchedRuleId`, so a
		// fallback resolution is reported too — it is the case an auditor most wants.
		if (!summary.expressionMappingActive) return;

		const { instanceRole } = decision;
		this.eventService.emit('expression-mapping-roles-resolved', {
			userId: user.id,
			userEmail: user.email,
			provider: decision.provider,
			instanceRole: {
				role: instanceRole?.roleSlug ?? '',
				previousRole: summary.previousInstanceRole ?? '',
				changed: summary.instanceRoleChanged,
				matchedRuleId: instanceRole?.matchedRuleId ?? null,
				expression: instanceRole?.expression ?? null,
				isFallback: instanceRole?.isFallback ?? false,
			},
			projectRoles: decision.projectRoles.map((role) => ({
				projectId: role.projectId,
				role: role.roleSlug,
				previousRole: summary.previousProjectRoles.get(role.projectId) ?? null,
				changed: summary.previousProjectRoles.get(role.projectId) !== role.roleSlug,
				matchedRuleId: role.matchedRuleId,
				expression: role.expression,
			})),
			removedProjectIds: summary.removedProjectIds,
		});
	}

	// ----------------------------------
	//        configuration internals
	// ----------------------------------

	private disabledDefaults(): ProvisioningConfigDto {
		const { provisioning } = this.globalConfig.sso;
		return {
			scopesProvisionInstanceRole: false,
			scopesProvisionProjectRoles: false,
			scopesUseExpressionMapping: false,
			scopesName: provisioning.scopesName,
			scopesInstanceRoleClaimName: provisioning.scopesInstanceRoleClaimName,
			scopesProjectsRolesClaimName: provisioning.scopesProjectsRolesClaimName,
		};
	}

	private async assertAssignableDefaultRole(slug: string): Promise<void> {
		if (slug === BLOCK_ACCESS_ASSIGNMENT) return;

		if (slug === GLOBAL_OWNER_ROLE.slug) {
			throw new BadRequestError('The instance owner role cannot be assigned by provisioning');
		}

		const role = await this.roleRepository.findBySlug(slug);
		if (!role) {
			throw new BadRequestError(`Could not find role with slug "${slug}"`);
		}
		if (role.roleType !== 'global') {
			throw new BadRequestError('The default instance role must be a global role');
		}
	}

	private async broadcastReload(): Promise<void> {
		const { Publisher } = await import('@/scaling/pubsub/publisher.service.js');
		await Container.get(Publisher).publishCommand({
			command: 'reload-sso-provisioning-configuration',
		});
	}
}

type BooleanField =
	| 'scopesProvisionInstanceRole'
	| 'scopesProvisionProjectRoles'
	| 'scopesUseExpressionMapping';
type StringField = 'scopesName' | 'scopesInstanceRoleClaimName' | 'scopesProjectsRolesClaimName';

/** `null` resets a field to its instance default; `undefined` leaves it alone. */
function applyBoolean(
	merged: ProvisioningConfigDto,
	patch: ProvisioningConfigPatchDto,
	field: BooleanField,
	defaults: ProvisioningConfigDto,
): void {
	const value = patch[field];
	if (value === null) merged[field] = defaults[field];
	else if (value !== undefined) merged[field] = value;
}

function applyString(
	merged: ProvisioningConfigDto,
	patch: ProvisioningConfigPatchDto,
	field: StringField,
	defaults: ProvisioningConfigDto,
): void {
	const value = patch[field];
	if (value === null) merged[field] = defaults[field];
	else if (value !== undefined) merged[field] = value;
}

function buildExpressionContext(input: ProvisioningEvaluationInput): ProvisioningExpressionContext {
	if (input.providerContext.provider === 'oidc') {
		return {
			$claims: input.claims,
			$provider: 'oidc',
			$oidc: {
				idToken: input.providerContext.idToken,
				userInfo: input.providerContext.userInfo,
			},
		};
	}
	return { $claims: input.providerContext.rawAttributes, $provider: 'saml' };
}
