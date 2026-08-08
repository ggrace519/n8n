import { mockInstance } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { ProjectRelationRepository } from '@n8n/db';
import type { Scope } from '@n8n/permissions';
import { mock } from 'vitest-mock-extended';

import { ProjectScopeService } from '@/permissions/project-scope.service';
import { RoleService } from '@/services/role.service';

describe('ProjectScopeService', () => {
	const roleService = mockInstance(RoleService);
	const projectRelationRepository = mockInstance(ProjectRelationRepository);

	const projectScopeService = new ProjectScopeService(roleService, projectRelationRepository);

	const userWithGlobalScopes = (scopes: Scope[]): User =>
		mock<User>({
			id: 'user-1',
			role: { slug: 'test-role', scopes: scopes.map((slug) => ({ slug })) },
		});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getProjectIds', () => {
		it('should return null (no filter) when the global role holds ALL scopes', async () => {
			const user = userWithGlobalScopes(['agent:list', 'agent:update']);

			await expect(
				projectScopeService.getProjectIds(user, ['agent:list', 'agent:update']),
			).resolves.toBeNull();

			expect(projectRelationRepository.getAccessibleProjectsByRoles).not.toHaveBeenCalled();
		});

		it('should return the granting project IDs when only SOME scopes are held globally', async () => {
			const user = userWithGlobalScopes(['agent:list']);
			roleService.rolesWithScope.mockResolvedValue(['project:admin']);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue(['p1', 'p2']);

			await expect(
				projectScopeService.getProjectIds(user, ['agent:list', 'agent:update']),
			).resolves.toEqual(['p1', 'p2']);

			expect(roleService.rolesWithScope).toHaveBeenCalledWith('project', [
				'agent:list',
				'agent:update',
			]);
			expect(projectRelationRepository.getAccessibleProjectsByRoles).toHaveBeenCalledWith(
				'user-1',
				['project:admin'],
			);
		});

		it('should return an empty list (not null) when no project grants the scopes', async () => {
			const user = userWithGlobalScopes([]);
			roleService.rolesWithScope.mockResolvedValue([]);
			projectRelationRepository.getAccessibleProjectsByRoles.mockResolvedValue([]);

			await expect(projectScopeService.getProjectIds(user, ['agent:update'])).resolves.toEqual([]);
		});
	});
});
