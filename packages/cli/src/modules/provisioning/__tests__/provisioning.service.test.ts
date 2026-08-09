import { BLOCK_ACCESS_ASSIGNMENT, type ProvisioningConfigDto } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type {
	ProjectRelation,
	ProjectRelationRepository,
	Role,
	RoleMappingRule,
	RoleMappingRuleRepository,
	RoleRepository,
	SettingsRepository,
	User,
	UserRepository,
} from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { EventService } from '@/events/event.service';

import type { ProvisioningExpressionEvaluator } from '../provisioning-expression-evaluator';
import { ProvisioningExpressionError } from '../provisioning-expression-evaluator';
import { ProvisioningService } from '../provisioning.service';
import type { ProvisioningEvaluationInput } from '../types';

const globalConfig = mock<GlobalConfig>({
	sso: {
		provisioning: {
			scopesName: 'n8n',
			scopesInstanceRoleClaimName: 'n8n_instance_role',
			scopesProjectsRolesClaimName: 'n8n_projects',
		},
	},
});

const disabledConfig = (): ProvisioningConfigDto => ({
	scopesProvisionInstanceRole: false,
	scopesProvisionProjectRoles: false,
	scopesUseExpressionMapping: false,
	scopesName: 'n8n',
	scopesInstanceRoleClaimName: 'n8n_instance_role',
	scopesProjectsRolesClaimName: 'n8n_projects',
});

const rule = (
	id: string,
	order: number,
	type: 'instance' | 'project',
	roleSlug: string,
	projectIds: string[] = [],
): RoleMappingRule =>
	({
		id,
		order,
		type,
		expression: `{{ ${id} }}`,
		role: { slug: roleSlug },
		projects: projectIds.map((projectId) => ({ id: projectId })),
	}) as unknown as RoleMappingRule;

const relation = (projectId: string, roleSlug: string, projectType = 'team'): ProjectRelation =>
	({
		projectId,
		role: { slug: roleSlug },
		project: { id: projectId, type: projectType },
	}) as unknown as ProjectRelation;

const samlInput = (claims: Record<string, unknown> = {}): ProvisioningEvaluationInput => ({
	provider: 'saml',
	claims,
	providerContext: { provider: 'saml', rawAttributes: claims },
});

describe('ProvisioningService', () => {
	const settingsRepository = mock<SettingsRepository>();
	const logger = mock<Logger>();
	const roleMappingRuleRepository = mock<RoleMappingRuleRepository>();
	const roleRepository = mock<RoleRepository>();
	const projectRelationRepository = mock<ProjectRelationRepository>();
	const userRepository = mock<UserRepository>();
	const expressionEvaluator = mock<ProvisioningExpressionEvaluator>();
	const eventService = mock<EventService>();

	let service: ProvisioningService;

	/** Seed the in-memory policy without going through the settings row. */
	const withConfig = async (overrides: Partial<ProvisioningConfigDto> = {}) => {
		settingsRepository.findByKey.mockResolvedValue({
			key: 'sso.provisioning.config',
			value: JSON.stringify({ ...disabledConfig(), ...overrides }),
			loadOnStartup: true,
		} as never);
		await service.handleReloadSsoProvisioningConfiguration();
	};

	beforeEach(() => {
		vi.clearAllMocks();
		settingsRepository.findByKey.mockResolvedValue(null);
		roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([]);
		roleMappingRuleRepository.countByType.mockResolvedValue(0);
		projectRelationRepository.getRelationsForUser.mockResolvedValue([]);

		service = new ProvisioningService(
			settingsRepository,
			globalConfig,
			logger,
			roleMappingRuleRepository,
			roleRepository,
			projectRelationRepository,
			userRepository,
			expressionEvaluator,
			eventService,
		);
	});

	describe('getProvisioningConfig', () => {
		it('falls back to disabled defaults when no row is stored', async () => {
			expect(await service.getProvisioningConfig()).toEqual(disabledConfig());
		});

		it('falls back to disabled defaults when the stored row is partial', async () => {
			settingsRepository.findByKey.mockResolvedValue({
				key: 'sso.provisioning.config',
				value: JSON.stringify({ scopesUseExpressionMapping: true }),
				loadOnStartup: true,
			} as never);

			expect(await service.getProvisioningConfig()).toEqual(disabledConfig());
		});

		it('is idempotent across repeated init calls', async () => {
			await service.init();
			await service.init();

			expect(settingsRepository.findByKey).toHaveBeenCalledTimes(1);
		});
	});

	describe('managed-role semantics', () => {
		it('reports instance roles as managed when claim provisioning is on', async () => {
			await withConfig({ scopesProvisionInstanceRole: true });

			expect(await service.isInstanceRoleManaged()).toBe(true);
		});

		it('does not report instance roles as managed for expression mapping without instance rules', async () => {
			await withConfig({ scopesUseExpressionMapping: true });
			roleMappingRuleRepository.countByType.mockResolvedValue(0);

			expect(await service.isInstanceRoleManaged()).toBe(false);
		});

		it('reports instance roles as managed once an instance rule exists', async () => {
			await withConfig({ scopesUseExpressionMapping: true });
			roleMappingRuleRepository.countByType.mockResolvedValue(1);

			expect(await service.isInstanceRoleManaged()).toBe(true);
		});

		it('reports project roles as managed only once a project rule exists', async () => {
			await withConfig({ scopesUseExpressionMapping: true });

			roleMappingRuleRepository.countByType.mockResolvedValue(0);
			expect(await service.isProjectRoleManaged()).toBe(false);

			roleMappingRuleRepository.countByType.mockResolvedValue(2);
			expect(await service.isProjectRoleManaged()).toBe(true);
		});
	});

	describe('resolveLoginProvisioning — instance rules', () => {
		beforeEach(async () => {
			await withConfig({ scopesUseExpressionMapping: true });
		});

		it('takes the first matching rule in order', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockImplementation(async (type) =>
				type === 'instance'
					? [
							rule('first', 0, 'instance', 'global:member'),
							rule('second', 1, 'instance', 'global:admin'),
							rule('third', 2, 'instance', 'global:member'),
						]
					: [],
			);
			expressionEvaluator.evaluate.mockImplementation(
				async (ruleId) => ruleId === 'second' || ruleId === 'third',
			);

			const decision = await service.resolveLoginProvisioning(samlInput());

			expect(decision).toMatchObject({
				outcome: 'allow',
				instanceRole: { roleSlug: 'global:admin', matchedRuleId: 'second', isFallback: false },
			});
			// Evaluation stops at the first match, so the third rule is never run.
			expect(expressionEvaluator.evaluate).toHaveBeenCalledTimes(2);
		});

		it('falls back to global:member when no rule matches and no default is set', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([
				rule('only', 0, 'instance', 'global:admin'),
			]);
			expressionEvaluator.evaluate.mockResolvedValue(false);

			const decision = await service.resolveLoginProvisioning(samlInput());

			expect(decision).toMatchObject({
				outcome: 'allow',
				instanceRole: { roleSlug: 'global:member', matchedRuleId: null, isFallback: true },
			});
		});

		it('applies the configured default role when no rule matches', async () => {
			await withConfig({ scopesUseExpressionMapping: true, defaultInstanceRole: 'global:admin' });
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([
				rule('only', 0, 'instance', 'global:member'),
			]);
			expressionEvaluator.evaluate.mockResolvedValue(false);

			const decision = await service.resolveLoginProvisioning(samlInput());

			expect(decision).toMatchObject({
				outcome: 'allow',
				instanceRole: { roleSlug: 'global:admin', isFallback: true },
			});
		});

		it('denies the login when the default condition blocks access and nothing matched', async () => {
			await withConfig({
				scopesUseExpressionMapping: true,
				defaultInstanceRole: BLOCK_ACCESS_ASSIGNMENT,
			});
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([
				rule('only', 0, 'instance', 'global:admin'),
			]);
			expressionEvaluator.evaluate.mockResolvedValue(false);

			expect(await service.resolveLoginProvisioning(samlInput())).toEqual({
				outcome: 'deny',
				reason: 'block-access',
			});
		});

		it('lets a matching rule win over a blocking default condition', async () => {
			await withConfig({
				scopesUseExpressionMapping: true,
				defaultInstanceRole: BLOCK_ACCESS_ASSIGNMENT,
			});
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockImplementation(async (type) =>
				type === 'instance' ? [rule('only', 0, 'instance', 'global:admin')] : [],
			);
			expressionEvaluator.evaluate.mockResolvedValue(true);

			expect(await service.resolveLoginProvisioning(samlInput())).toMatchObject({
				outcome: 'allow',
				instanceRole: { roleSlug: 'global:admin' },
			});
		});

		it('denies the login when a rule cannot be evaluated', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([
				rule('only', 0, 'instance', 'global:admin'),
			]);
			expressionEvaluator.evaluate.mockRejectedValue(
				new ProvisioningExpressionError('only', 'timeout'),
			);

			expect(await service.resolveLoginProvisioning(samlInput())).toEqual({
				outcome: 'deny',
				reason: 'evaluation-failed',
			});
		});

		it('records only the rule id and failure class when an evaluation fails', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockResolvedValue([
				rule('only', 0, 'instance', 'global:admin'),
			]);
			expressionEvaluator.evaluate.mockRejectedValue(
				new ProvisioningExpressionError('only', 'security'),
			);

			await service.resolveLoginProvisioning(samlInput({ department: 'secret-value' }));

			expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
				ruleId: 'only',
				failure: 'security',
				provider: 'saml',
			});
			expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-value');
		});

		it('leaves the instance role alone when nothing is configured', async () => {
			await withConfig();

			expect(await service.resolveLoginProvisioning(samlInput())).toEqual({
				outcome: 'allow',
				provider: 'saml',
				instanceRole: undefined,
				projectRoles: [],
				managedProjectIds: [],
			});
		});
	});

	describe('resolveLoginProvisioning — project rules', () => {
		beforeEach(async () => {
			await withConfig({ scopesUseExpressionMapping: true });
		});

		it('resolves each project from the first matching rule that links it', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockImplementation(async (type) =>
				type === 'project'
					? [
							rule('p1', 0, 'project', 'project:editor', ['proj-a']),
							rule('p2', 1, 'project', 'project:viewer', ['proj-a', 'proj-b']),
						]
					: [],
			);
			expressionEvaluator.evaluate.mockResolvedValue(true);

			const decision = await service.resolveLoginProvisioning(samlInput());

			expect(decision).toMatchObject({
				outcome: 'allow',
				projectRoles: [
					{ projectId: 'proj-a', roleSlug: 'project:editor', matchedRuleId: 'p1' },
					{ projectId: 'proj-b', roleSlug: 'project:viewer', matchedRuleId: 'p2' },
				],
			});
		});

		it('reports every rule-linked project as managed even when nothing matched', async () => {
			roleMappingRuleRepository.findByTypeInEvaluationOrder.mockImplementation(async (type) =>
				type === 'project' ? [rule('p1', 0, 'project', 'project:editor', ['proj-a'])] : [],
			);
			expressionEvaluator.evaluate.mockResolvedValue(false);

			const decision = await service.resolveLoginProvisioning(samlInput());

			expect(decision).toMatchObject({ projectRoles: [], managedProjectIds: ['proj-a'] });
		});
	});

	describe('resolveLoginProvisioning — direct claims', () => {
		it('assigns the instance role named by the claim', async () => {
			await withConfig({ scopesProvisionInstanceRole: true });
			roleRepository.findBySlug.mockResolvedValue({
				slug: 'global:admin',
				roleType: 'global',
			} as Role);

			const decision = await service.resolveLoginProvisioning({
				...samlInput(),
				directClaims: { instanceRole: 'global:admin' },
			});

			expect(decision).toMatchObject({
				outcome: 'allow',
				instanceRole: { roleSlug: 'global:admin', matchedRuleId: null, isFallback: false },
			});
		});

		it.each([
			['an unknown role', null],
			['a project role', { slug: 'project:editor', roleType: 'project' }],
			['the owner role', { slug: 'global:owner', roleType: 'global' }],
		])('ignores an instance-role claim naming %s', async (_label, stored) => {
			await withConfig({ scopesProvisionInstanceRole: true });
			roleRepository.findBySlug.mockResolvedValue(stored as Role | null);

			const decision = await service.resolveLoginProvisioning({
				...samlInput(),
				directClaims: { instanceRole: 'whatever' },
			});

			// No default condition is set, and direct-claim provisioning leaves the
			// role alone rather than falling back to a role of its own.
			expect(decision).toMatchObject({ outcome: 'allow', instanceRole: undefined });
		});

		it('reads project claims as <projectId>:<roleSlug>', async () => {
			await withConfig({ scopesProvisionProjectRoles: true });
			roleRepository.findBySlug.mockResolvedValue({
				slug: 'project:editor',
				roleType: 'project',
			} as Role);

			const decision = await service.resolveLoginProvisioning({
				...samlInput(),
				directClaims: { projectRoles: ['proj-a:project:editor'] },
			});

			expect(decision).toMatchObject({
				outcome: 'allow',
				projectRoles: [{ projectId: 'proj-a', roleSlug: 'project:editor' }],
				managedProjectIds: ['proj-a'],
			});
		});

		it.each([
			['an unparsable entry', 'no-separator', null],
			['an unknown role', 'proj-a:project:nope', null],
			['a global role', 'proj-a:global:admin', { slug: 'global:admin', roleType: 'global' }],
		])('skips %s without denying the login', async (_label, entry, stored) => {
			await withConfig({ scopesProvisionProjectRoles: true });
			roleRepository.findBySlug.mockResolvedValue(stored as Role | null);

			const decision = await service.resolveLoginProvisioning({
				...samlInput(),
				directClaims: { projectRoles: [entry] },
			});

			expect(decision).toMatchObject({ outcome: 'allow', projectRoles: [] });
		});
	});

	describe('applyLoginProvisioning', () => {
		const user = { id: 'user-1', email: 'u@example.com', role: { slug: 'global:member' } } as User;

		beforeEach(async () => {
			await withConfig({ scopesUseExpressionMapping: true });
		});

		it('writes nothing for a denial', async () => {
			const result = await service.applyLoginProvisioning(user, {
				outcome: 'deny',
				reason: 'block-access',
			});

			expect(result).toEqual({
				instanceRoleChanged: false,
				projectsAdded: 0,
				projectsRemoved: 0,
			});
			expect(userRepository.updateGlobalRole).not.toHaveBeenCalled();
			expect(projectRelationRepository.applyProvisionedRelationsForUser).not.toHaveBeenCalled();
		});

		it('assigns a changed instance role and reports it', async () => {
			const result = await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:admin',
					matchedRuleId: 'r1',
					expression: '{{ true }}',
					isFallback: false,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(result.instanceRoleChanged).toBe(true);
			expect(userRepository.updateGlobalRole).toHaveBeenCalledWith('user-1', 'global:admin');
			expect(eventService.emit).toHaveBeenCalledWith('sso-user-instance-role-updated', {
				role: 'global:admin',
				userId: 'user-1',
			});
		});

		it('leaves an unchanged instance role untouched', async () => {
			const result = await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:member',
					matchedRuleId: null,
					expression: null,
					isFallback: true,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(result.instanceRoleChanged).toBe(false);
			expect(userRepository.updateGlobalRole).not.toHaveBeenCalled();
		});

		it('never re-assigns the instance owner', async () => {
			const owner = { ...user, role: { slug: 'global:owner' } as Role } as User;

			const result = await service.applyLoginProvisioning(owner, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:member',
					matchedRuleId: 'r1',
					expression: '{{ true }}',
					isFallback: false,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(result.instanceRoleChanged).toBe(false);
			expect(userRepository.updateGlobalRole).not.toHaveBeenCalled();
		});

		it('revokes managed projects the login no longer grants and keeps the rest', async () => {
			projectRelationRepository.getRelationsForUser.mockResolvedValue([
				relation('proj-a', 'project:viewer'),
				relation('proj-managed-gone', 'project:viewer'),
				relation('proj-unmanaged', 'project:admin'),
				relation('personal-1', 'project:personalOwner', 'personal'),
			]);

			const result = await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				projectRoles: [
					{
						projectId: 'proj-a',
						roleSlug: 'project:editor',
						matchedRuleId: 'p1',
						expression: '{{ true }}',
					},
				],
				managedProjectIds: ['proj-a', 'proj-managed-gone', 'personal-1'],
			});

			expect(projectRelationRepository.applyProvisionedRelationsForUser).toHaveBeenCalledWith(
				'user-1',
				[{ projectId: 'proj-a', roleSlug: 'project:editor' }],
				['proj-managed-gone'],
			);
			expect(result).toMatchObject({ projectsAdded: 1, projectsRemoved: 1 });
			expect(eventService.emit).toHaveBeenCalledWith('sso-user-project-access-updated', {
				projectsAdded: 1,
				projectsRemoved: 1,
				userId: 'user-1',
			});
		});

		it('reports a fallback resolution through the audit event too', async () => {
			await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:member',
					matchedRuleId: null,
					expression: null,
					isFallback: true,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(eventService.emit).toHaveBeenCalledWith(
				'expression-mapping-roles-resolved',
				expect.objectContaining({
					instanceRole: expect.objectContaining({ matchedRuleId: null, isFallback: true }),
				}),
			);
		});

		it('does not emit the audit event when expression mapping is off', async () => {
			await withConfig();

			await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:admin',
					matchedRuleId: null,
					expression: null,
					isFallback: false,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(eventService.emit).not.toHaveBeenCalledWith(
				'expression-mapping-roles-resolved',
				expect.anything(),
			);
		});

		it('emits the expression-mapping audit event with the matched rules', async () => {
			await service.applyLoginProvisioning(user, {
				outcome: 'allow',
				provider: 'saml',
				instanceRole: {
					roleSlug: 'global:admin',
					matchedRuleId: 'r1',
					expression: '{{ dept }}',
					isFallback: false,
				},
				projectRoles: [],
				managedProjectIds: [],
			});

			expect(eventService.emit).toHaveBeenCalledWith(
				'expression-mapping-roles-resolved',
				expect.objectContaining({
					userId: 'user-1',
					provider: 'saml',
					instanceRole: expect.objectContaining({
						role: 'global:admin',
						previousRole: 'global:member',
						matchedRuleId: 'r1',
						changed: true,
					}),
				}),
			);
		});
	});

	describe('updateProvisioningConfig', () => {
		const actor = { id: 'admin-1' } as User;

		beforeEach(() => {
			roleRepository.findBySlug.mockResolvedValue({
				slug: 'global:admin',
				roleType: 'global',
			} as Role);
		});

		it('persists the merged document, not the patch', async () => {
			await withConfig({ scopesUseExpressionMapping: true });

			const merged = await service.updateProvisioningConfig(
				{ defaultInstanceRole: 'global:admin' },
				actor,
			);

			expect(merged.scopesUseExpressionMapping).toBe(true);
			expect(merged.defaultInstanceRole).toBe('global:admin');
			const [row] = settingsRepository.upsert.mock.calls[0];
			expect(JSON.parse((row as { value: string }).value)).toEqual(merged);
		});

		it('removes the default condition when patched with null', async () => {
			await withConfig({ defaultInstanceRole: BLOCK_ACCESS_ASSIGNMENT });

			const merged = await service.updateProvisioningConfig({ defaultInstanceRole: null }, actor);

			expect(merged).not.toHaveProperty('defaultInstanceRole');
		});

		it('accepts block access without touching the role table', async () => {
			const merged = await service.updateProvisioningConfig(
				{ defaultInstanceRole: BLOCK_ACCESS_ASSIGNMENT },
				actor,
			);

			expect(merged.defaultInstanceRole).toBe(BLOCK_ACCESS_ASSIGNMENT);
			expect(roleRepository.findBySlug).not.toHaveBeenCalled();
		});

		it.each([
			['the owner role', 'global:owner', { slug: 'global:owner', roleType: 'global' }],
			['a project role', 'project:editor', { slug: 'project:editor', roleType: 'project' }],
			['an unknown role', 'global:nope', null],
		])('rejects %s as the default condition', async (_label, slug, stored) => {
			roleRepository.findBySlug.mockResolvedValue(stored as Role | null);

			await expect(
				service.updateProvisioningConfig({ defaultInstanceRole: slug }, actor),
			).rejects.toThrowError();
			expect(settingsRepository.upsert).not.toHaveBeenCalled();
		});

		it('clears the project rule space when asked to', async () => {
			roleMappingRuleRepository.deleteAllOfType.mockResolvedValue(3);

			await service.updateProvisioningConfig({ deleteProjectRules: true }, actor);

			expect(roleMappingRuleRepository.deleteAllOfType).toHaveBeenCalledWith('project');
			expect(eventService.emit).toHaveBeenCalledWith('role-mapping-rules-bulk-deleted', {
				ruleType: 'project',
				count: 3,
				reason: 'strategy-switch',
			});
		});
	});
});
