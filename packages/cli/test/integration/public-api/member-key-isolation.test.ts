import {
	createTeamProject,
	createWorkflow,
	randomCredentialPayload,
	testDb,
} from '@n8n/backend-test-utils';
import type { CredentialsEntity, Project, User, WorkflowEntity } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import { saveCredential } from '../shared/db/credentials';
import { createFolder } from '../shared/db/folders';
import { createMember, createMemberWithApiKey } from '../shared/db/users';
import type { SuperAgentTest } from '../shared/types';
import * as utils from '../shared/utils/';

/**
 * A member's key now carries scopes derived from their project roles. Each such
 * scope is only grantable because its routes re-check access to the specific
 * resource, so a key holding all of them must still be confined to the member's
 * own projects.
 */
describe('Public API: member key confined to own projects', () => {
	const testServer = utils.setupTestServer({ endpointGroups: ['publicApi'] });

	let attacker: User;
	let attackerAgent: SuperAgentTest;
	let victimProject: Project;
	let teamProject: Project;
	let ownWorkflow: WorkflowEntity;
	let victimWorkflow: WorkflowEntity;
	let victimCredential: CredentialsEntity;

	beforeAll(async () => {
		attacker = await createMemberWithApiKey();
		attackerAgent = testServer.publicApiAgentFor(attacker);

		const victim = await createMember();
		victimProject = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
			victim.id,
		);
		teamProject = await createTeamProject();

		ownWorkflow = await createWorkflow({}, attacker);
		victimWorkflow = await createWorkflow({}, victim);
		victimCredential = await saveCredential(randomCredentialPayload(), {
			user: victim,
			role: 'credential:owner',
		});
		await createFolder(victimProject);
	});

	afterAll(async () => {
		await testDb.truncate([
			'SharedWorkflow',
			'WorkflowEntity',
			'SharedCredentials',
			'CredentialsEntity',
		]);
	});

	test('the key holds the project-derived scopes under test', () => {
		expect(attacker.apiKeys[0].scopes).toEqual(
			expect.arrayContaining([
				'workflow:read',
				'workflow:list',
				'workflow:delete',
				'credential:read',
				'folder:list',
				'execution:list',
			]),
		);
	});

	test('can read its own workflow', async () => {
		await attackerAgent.get(`/workflows/${ownWorkflow.id}`).expect(200);
	});

	test("cannot read or delete another member's workflow", async () => {
		await attackerAgent.get(`/workflows/${victimWorkflow.id}`).expect(403);
		await attackerAgent.delete(`/workflows/${victimWorkflow.id}`).expect(403);
	});

	test("does not list another member's workflow", async () => {
		const response = await attackerAgent.get('/workflows').expect(200);

		const ids = (response.body.data as Array<{ id: string }>).map((workflow) => workflow.id);
		expect(ids).toContain(ownWorkflow.id);
		expect(ids).not.toContain(victimWorkflow.id);
	});

	test("cannot update, publish, or transfer another member's workflow", async () => {
		const attackerProject = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
			attacker.id,
		);

		await attackerAgent
			.put(`/workflows/${victimWorkflow.id}`)
			.send({ name: 'hijacked', nodes: [], connections: {}, settings: {} })
			.expect(403);
		await attackerAgent.post(`/workflows/${victimWorkflow.id}/activate`).expect(403);
		await attackerAgent
			.put(`/workflows/${victimWorkflow.id}/transfer`)
			.send({ destinationProjectId: attackerProject.id })
			.expect(403);
	});

	test("cannot read or delete another member's credential", async () => {
		await attackerAgent.get(`/credentials/${victimCredential.id}`).expect(403);
		await attackerAgent.delete(`/credentials/${victimCredential.id}`).expect(403);
	});

	test('cannot list every user on the instance', async () => {
		expect(attacker.apiKeys[0].scopes).toContain('user:list');

		await attackerAgent.get('/users').expect(403);
	});

	test("cannot list folders in another member's or a foreign team project", async () => {
		await attackerAgent.get(`/projects/${victimProject.id}/folders`).expect(403);
		await attackerAgent.get(`/projects/${teamProject.id}/folders`).expect(403);
	});

	test("lists no executions for another member's workflow", async () => {
		const response = await attackerAgent
			.get('/executions')
			.query({ workflowId: victimWorkflow.id })
			.expect(200);

		expect(response.body.data).toEqual([]);
	});
});
