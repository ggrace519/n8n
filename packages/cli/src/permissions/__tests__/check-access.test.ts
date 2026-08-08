import { mockInstance } from '@n8n/backend-test-utils';
import type { DataTable } from '@/modules/data-table/data-table.entity';
import type { SharedCredentials, SharedWorkflow, User } from '@n8n/db';
import {
	ProjectRelationRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
} from '@n8n/db';
import type { EntityManager } from '@n8n/db';
import type { Scope } from '@n8n/permissions';
import { UnexpectedError } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { userHasScopes } from '@/permissions/check-access';
import { RoleService } from '@/services/role.service';

describe('userHasScopes', () => {
	const roleService = mockInstance(RoleService);
	const projectRelationRepository = mockInstance(ProjectRelationRepository);
	const sharedWorkflowRepository = mockInstance(SharedWorkflowRepository);
	const sharedCredentialsRepository = mockInstance(SharedCredentialsRepository);
	const dataTableRepository = mockInstance(DataTableRepository);

	const userWithGlobalScopes = (scopes: Scope[]): User =>
		mock<User>({
			id: 'user-1',
			role: { slug: 'test-role', scopes: scopes.map((slug) => ({ slug })) },
		});

	beforeEach(() => {
		vi.clearAllMocks();
		roleService.rolesWithScope.mockResolvedValue([]);
		projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue([]);
	});

	describe('global scopes', () => {
		it('should pass when the global role holds ALL required scopes', async () => {
			const user = userWithGlobalScopes(['workflow:read', 'workflow:update']);

			await expect(
				userHasScopes(user, ['workflow:read', 'workflow:update'], false, { workflowId: 'w1' }),
			).resolves.toBe(true);

			expect(roleService.rolesWithScope).not.toHaveBeenCalled();
			expect(projectRelationRepository.getAccessibleProjectsByRoles).not.toHaveBeenCalled();
		});

		it('should not pass globally when only SOME required scopes are held', async () => {
			const user = userWithGlobalScopes(['workflow:read']);

			await expect(
				userHasScopes(user, ['workflow:read', 'workflow:update'], false, { projectId: 'p1' }),
			).resolves.toBe(false);

			expect(projectRelationRepository.getAccessibleProjectsByRoles).toHaveBeenCalled();
		});

		it('should return false for globalOnly when the global role lacks the scopes', async () => {
			const user = userWithGlobalScopes(['workflow:read']);

			await expect(userHasScopes(user, ['user:list'], true, {})).resolves.toBe(false);

			expect(roleService.rolesWithScope).not.toHaveBeenCalled();
		});
	});

	describe('projectId context', () => {
		it('should grant when the user has a granting role in the project', async () => {
			const user = userWithGlobalScopes([]);
			roleService.rolesWithScope.mockResolvedValue(['project:admin']);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1', 'p2']);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { projectId: 'p1' }),
			).resolves.toBe(true);
		});

		it('should deny when the project is not among the granting projects', async () => {
			const user = userWithGlobalScopes([]);
			roleService.rolesWithScope.mockResolvedValue(['project:admin']);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p2']);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { projectId: 'p1' }),
			).resolves.toBe(false);
		});
	});

	describe('workflowId context', () => {
		const user = userWithGlobalScopes([]);

		beforeEach(() => {
			roleService.rolesWithScope.mockImplementation(async (namespace: string) =>
				namespace === 'project' ? ['project:admin'] : ['workflow:owner'],
			);
		});

		it('should throw NotFoundError when the workflow has no relations at all', async () => {
			sharedWorkflowRepository.getAllRelationsForWorkflows.mockResolvedValue([]);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { workflowId: 'missing' }),
			).rejects.toThrow(NotFoundError);
		});

		it('should grant when one relation has both a sufficient sharing role and a granting project', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);
			sharedWorkflowRepository.getAllRelationsForWorkflows.mockResolvedValue([
				mock<SharedWorkflow>({ role: 'workflow:owner', projectId: 'p1' }),
			]);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { workflowId: 'w1' }),
			).resolves.toBe(true);
		});

		it('should deny when the sharing role is sufficient but the project is not granting', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p-other']);
			sharedWorkflowRepository.getAllRelationsForWorkflows.mockResolvedValue([
				mock<SharedWorkflow>({ role: 'workflow:owner', projectId: 'p1' }),
			]);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { workflowId: 'w1' }),
			).resolves.toBe(false);
		});

		it('should deny when the project is granting but the sharing role is insufficient', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);
			sharedWorkflowRepository.getAllRelationsForWorkflows.mockResolvedValue([
				mock<SharedWorkflow>({ role: 'workflow:editor', projectId: 'p1' }),
			]);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { workflowId: 'w1' }),
			).resolves.toBe(false);
		});

		it('should deny when role and project conditions hold only across DIFFERENT relations', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p2']);
			sharedWorkflowRepository.getAllRelationsForWorkflows.mockResolvedValue([
				mock<SharedWorkflow>({ role: 'workflow:owner', projectId: 'p1' }),
				mock<SharedWorkflow>({ role: 'workflow:editor', projectId: 'p2' }),
			]);

			await expect(
				userHasScopes(user, ['workflow:read'], false, { workflowId: 'w1' }),
			).resolves.toBe(false);
		});
	});

	describe('credentialId context', () => {
		const user = userWithGlobalScopes([]);

		beforeEach(() => {
			roleService.rolesWithScope.mockImplementation(async (namespace: string) =>
				namespace === 'project' ? ['project:admin'] : ['credential:owner'],
			);
		});

		it('should throw NotFoundError when the credential has no relations at all', async () => {
			sharedCredentialsRepository.getAllRelationsForCredentials.mockResolvedValue([]);

			await expect(
				userHasScopes(user, ['credential:read'], false, { credentialId: 'missing' }),
			).rejects.toThrow(NotFoundError);
		});

		it('should grant when one relation has both a sufficient sharing role and a granting project', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);
			sharedCredentialsRepository.getAllRelationsForCredentials.mockResolvedValue([
				mock<SharedCredentials>({ role: 'credential:owner', projectId: 'p1' }),
			]);

			await expect(
				userHasScopes(user, ['credential:read'], false, { credentialId: 'c1' }),
			).resolves.toBe(true);
		});

		it('should deny when no relation satisfies both conditions', async () => {
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p2']);
			sharedCredentialsRepository.getAllRelationsForCredentials.mockResolvedValue([
				mock<SharedCredentials>({ role: 'credential:owner', projectId: 'p1' }),
			]);

			await expect(
				userHasScopes(user, ['credential:read'], false, { credentialId: 'c1' }),
			).resolves.toBe(false);
		});
	});

	describe('dataTableId context', () => {
		const user = userWithGlobalScopes([]);

		it('should throw NotFoundError when the data table does not exist', async () => {
			dataTableRepository.findOneBy.mockResolvedValue(null);

			await expect(
				userHasScopes(user, ['dataTable:readRow'], false, { dataTableId: 'missing' }),
			).rejects.toThrow(NotFoundError);
		});

		it("should grant when the table's project is a granting project", async () => {
			roleService.rolesWithScope.mockResolvedValue(['project:admin']);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);
			dataTableRepository.findOneBy.mockResolvedValue(
				mock<DataTable>({ id: 'd1', projectId: 'p1' }),
			);

			await expect(
				userHasScopes(user, ['dataTable:readRow'], false, { dataTableId: 'd1' }),
			).resolves.toBe(true);
		});

		it("should deny when the table's project is not a granting project", async () => {
			roleService.rolesWithScope.mockResolvedValue(['project:admin']);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p2']);
			dataTableRepository.findOneBy.mockResolvedValue(
				mock<DataTable>({ id: 'd1', projectId: 'p1' }),
			);

			await expect(
				userHasScopes(user, ['dataTable:readRow'], false, { dataTableId: 'd1' }),
			).resolves.toBe(false);
		});
	});

	it('should throw UnexpectedError when no resource id is in the context', async () => {
		const user = userWithGlobalScopes([]);

		await expect(userHasScopes(user, ['workflow:read'], false, {})).rejects.toThrow(
			UnexpectedError,
		);
	});

	it('should tolerate unknown extra keys in the context (req.params passthrough)', async () => {
		const user = userWithGlobalScopes([]);
		roleService.rolesWithScope.mockResolvedValue(['project:admin']);
		projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);

		const params = { projectId: 'p1', somethingElse: 'x' } as { projectId: string };

		await expect(userHasScopes(user, ['workflow:read'], false, params)).resolves.toBe(true);
	});

	it('should thread the transaction manager into role and relation lookups', async () => {
		const user = userWithGlobalScopes([]);
		const trx = mock<EntityManager>();
		roleService.rolesWithScope.mockResolvedValue(['project:admin']);
		projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1']);

		await userHasScopes(user, ['workflow:read'], false, { projectId: 'p1' }, trx);

		expect(roleService.rolesWithScope).toHaveBeenCalledWith('project', ['workflow:read'], trx);
		expect(projectRelationRepository.getAccessibleProjectsByRoles).toHaveBeenCalledWith(
			user.id,
			['project:admin'],
			trx,
		);
	});
});
