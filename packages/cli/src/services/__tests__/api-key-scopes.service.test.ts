import type { ProjectRelation, ProjectRelationRepository, User } from '@n8n/db';
import { GLOBAL_MEMBER_SCOPES, GLOBAL_OWNER_SCOPES, type Scope } from '@n8n/permissions';
import { mock } from 'vitest-mock-extended';

import { ApiKeyScopesService } from '../api-key-scopes.service';

const userWithGlobalScopes = (scopes: Scope[]) =>
	mock<User>({ id: 'user-id', role: { scopes: scopes.map((slug) => ({ slug })) } });

const relationWithScopes = (scopes: Scope[]) =>
	mock<ProjectRelation>({ role: { scopes: scopes.map((slug) => ({ slug })) } });

describe('ApiKeyScopesService', () => {
	const projectRelationRepository = mock<ProjectRelationRepository>();
	const service = new ApiKeyScopesService(projectRelationRepository);

	beforeEach(() => {
		projectRelationRepository.findAllByUser.mockReset();
	});

	describe('getGrantableScopes', () => {
		test("unions the user's global scopes with the project-checked scopes of every project role", async () => {
			projectRelationRepository.findAllByUser.mockResolvedValue([
				relationWithScopes(['workflow:read']),
				relationWithScopes(['credential:create']),
			]);

			const scopes = await service.getGrantableScopes(userWithGlobalScopes(GLOBAL_MEMBER_SCOPES));

			expect(projectRelationRepository.findAllByUser).toHaveBeenCalledWith('user-id');
			expect(scopes).toEqual(
				expect.arrayContaining(['tag:read', 'workflow:read', 'credential:create']),
			);
		});

		test('does not derive project-management scopes from a project role', async () => {
			projectRelationRepository.findAllByUser.mockResolvedValue([
				relationWithScopes(['project:update', 'project:delete', 'credential:list']),
			]);

			const scopes = await service.getGrantableScopes(userWithGlobalScopes(GLOBAL_MEMBER_SCOPES));

			expect(scopes).not.toContain('project:update');
			expect(scopes).not.toContain('project:delete');
			expect(scopes).not.toContain('credential:list');
		});

		test('grants a user with no project relations only their global scopes', async () => {
			projectRelationRepository.findAllByUser.mockResolvedValue([]);

			const scopes = await service.getGrantableScopes(userWithGlobalScopes(GLOBAL_OWNER_SCOPES));

			expect(scopes).toContain('project:delete');
		});
	});

	describe('canGrant', () => {
		test('accepts scopes within the grantable set and rejects any outside it', async () => {
			projectRelationRepository.findAllByUser.mockResolvedValue([
				relationWithScopes(['workflow:read']),
			]);
			const member = userWithGlobalScopes(GLOBAL_MEMBER_SCOPES);

			expect(await service.canGrant(member, ['workflow:read', 'tag:read'])).toBe(true);
			expect(await service.canGrant(member, ['workflow:read', 'workflow:delete'])).toBe(false);
		});
	});
});
