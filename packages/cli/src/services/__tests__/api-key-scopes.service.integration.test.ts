import { createTeamProject, linkUserToProject, testDb } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';

import { createChatUser, createMember, createOwner } from '@test-integration/db/users';

import { ApiKeyScopesService } from '../api-key-scopes.service';

describe('ApiKeyScopesService', () => {
	let service: ApiKeyScopesService;

	beforeAll(async () => {
		await testDb.init();
		service = Container.get(ApiKeyScopesService);
	});

	beforeEach(async () => {
		await testDb.truncate(['User', 'ProjectRelation', 'Project']);
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	test("a member can grant workflow and credential scopes through their personal project's synced role", async () => {
		const member = await createMember();

		const scopes = await service.getGrantableScopes(member);

		expect(scopes).toEqual(
			expect.arrayContaining(['workflow:read', 'workflow:create', 'credential:create']),
		);
		expect(scopes).not.toContain('project:create');
		expect(scopes).not.toContain('user:create');
	});

	test('a chat user derives no scopes from the projects they can view', async () => {
		const chatUser = await createChatUser();
		const project = await createTeamProject();
		await linkUserToProject(chatUser, project, 'project:viewer');

		expect(await service.getGrantableScopes(chatUser)).toEqual([]);
	});

	test('an owner can still grant instance-wide scopes from their global role', async () => {
		const owner = await createOwner();

		expect(await service.canGrant(owner, ['project:create', 'user:create'])).toBe(true);
	});
});
