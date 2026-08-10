import {
	createTeamProject,
	linkUserToProject,
	createWorkflow,
	shareWorkflowWithUsers,
	testDb,
	mockInstance,
} from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';

import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import { WaitTracker } from '@/wait-tracker';

import {
	createSuccessfulExecution,
	createWaitingExecution,
	getAllExecutions,
} from './shared/db/executions';
import { createMember, createOwner } from './shared/db/users';
import { setupTestServer } from './shared/utils';

mockInstance(WaitTracker);
mockInstance(ConcurrencyControlService, {
	// @ts-expect-error Private property
	isEnabled: false,
});

const testServer = setupTestServer({ endpointGroups: ['executions'] });

let owner: User;
let member: User;

const saveExecution = async ({ belongingTo }: { belongingTo: User }) => {
	const workflow = await createWorkflow({}, belongingTo);
	return await createSuccessfulExecution(workflow);
};

const saveWaitingExecution = async ({ belongingTo }: { belongingTo: User }) => {
	const workflow = await createWorkflow({}, belongingTo);
	return await createWaitingExecution(workflow);
};

beforeEach(async () => {
	await testDb.truncate(['ExecutionEntity', 'WorkflowEntity', 'SharedWorkflow']);
	testServer.license.reset();
	owner = await createOwner();
	member = await createMember();
});

describe('GET /executions', () => {
	test('returns executions of workflows shared with the user regardless of sharing license', async () => {
		const workflow = await createWorkflow({}, owner);
		await shareWorkflowWithUsers(workflow, [member]);
		await createSuccessfulExecution(workflow);

		const responseWithoutLicense = await testServer
			.authAgentFor(member)
			.get('/executions')
			.expect(200);
		expect(responseWithoutLicense.body.data.count).toBe(1);

		testServer.license.enable('feat:sharing');

		const responseWithLicense = await testServer
			.authAgentFor(member)
			.get('/executions')
			.expect(200);
		expect(responseWithLicense.body.data.count).toBe(1);
	});

	test('project admins can list executions of project workflows without the sharing license', async () => {
		const teamProject = await createTeamProject();
		await linkUserToProject(member, teamProject, 'project:admin');

		const workflow = await createWorkflow({}, teamProject);
		await createSuccessfulExecution(workflow);

		const response = await testServer.authAgentFor(member).get('/executions').expect(200);

		expect(response.body.data.count).toBe(1);
	});

	test('should return a scopes array for each execution', async () => {
		testServer.license.enable('feat:sharing');
		const workflow = await createWorkflow({}, owner);
		await shareWorkflowWithUsers(workflow, [member]);
		await createSuccessfulExecution(workflow);

		const response = await testServer.authAgentFor(member).get('/executions').expect(200);
		expect(response.body.data.results[0].scopes).toContain('workflow:execute');
	});
});

describe('GET /executions/:id', () => {
	test('project viewers can view executions for workflows in the project', async () => {
		const teamProject = await createTeamProject();
		await linkUserToProject(member, teamProject, 'project:viewer');

		const workflow = await createWorkflow({}, teamProject);
		const execution = await createSuccessfulExecution(workflow);

		const response = await testServer.authAgentFor(member).get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toBeDefined();
	});

	test('project admins can view executions for workflows in the project without the sharing license', async () => {
		const teamProject = await createTeamProject();
		await linkUserToProject(member, teamProject, 'project:admin');

		const workflow = await createWorkflow({}, teamProject);
		const execution = await createSuccessfulExecution(workflow);

		const response = await testServer.authAgentFor(member).get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toBeDefined();
	});

	test('returns executions of workflows shared with the user without the sharing license', async () => {
		const workflow = await createWorkflow({}, owner);
		await shareWorkflowWithUsers(workflow, [member]);
		const execution = await createSuccessfulExecution(workflow);

		const response = await testServer
			.authAgentFor(member)
			.get(`/executions/${execution.id}`)
			.expect(200);

		expect(response.body.data.id).toBe(execution.id);
	});
});

describe('PATCH /executions/:id', () => {
	test('returns the full updated execution, not a bare annotation', async () => {
		const execution = await saveExecution({ belongingTo: owner });

		const response = await testServer
			.authAgentFor(owner)
			.patch(`/executions/${execution.id}`)
			.send({ vote: 'up' })
			.expect(200);

		// The editor store does `addExecution(response)`, so the payload has to be
		// a whole execution rather than just what changed.
		expect(response.body.data).toMatchObject({
			id: execution.id,
			workflowId: execution.workflowId,
			status: execution.status,
			annotation: expect.objectContaining({ vote: 'up' }),
		});
	});

	test('persists a note and round-trips it on read', async () => {
		const execution = await saveExecution({ belongingTo: owner });

		await testServer
			.authAgentFor(owner)
			.patch(`/executions/${execution.id}`)
			.send({ note: 'looks wrong on retry' })
			.expect(200);

		const response = await testServer
			.authAgentFor(owner)
			.get(`/executions/${execution.id}`)
			.expect(200);

		expect(response.body.data.annotation).toMatchObject({ note: 'looks wrong on retry' });
	});

	test('a vote-only update does not erase an existing note', async () => {
		const execution = await saveExecution({ belongingTo: owner });
		const agent = testServer.authAgentFor(owner);

		await agent.patch(`/executions/${execution.id}`).send({ note: 'keep me' }).expect(200);
		await agent.patch(`/executions/${execution.id}`).send({ vote: 'down' }).expect(200);

		const response = await agent.get(`/executions/${execution.id}`).expect(200);

		expect(response.body.data.annotation).toMatchObject({ note: 'keep me', vote: 'down' });
	});

	test('reports unknown tag ids as not found rather than a server error', async () => {
		const execution = await saveExecution({ belongingTo: owner });

		await testServer
			.authAgentFor(owner)
			.patch(`/executions/${execution.id}`)
			.send({ tags: ['does-not-exist'] })
			.expect(404);
	});

	test('a project viewer cannot annotate, matching what the editor offers', async () => {
		const teamProject = await createTeamProject();
		await linkUserToProject(member, teamProject, 'project:viewer');

		const workflow = await createWorkflow({}, teamProject);
		const execution = await createSuccessfulExecution(workflow);

		// The viewer can read the execution...
		await testServer.authAgentFor(member).get(`/executions/${execution.id}`).expect(200);

		// ...but annotating it is a write.
		await testServer
			.authAgentFor(member)
			.patch(`/executions/${execution.id}`)
			.send({ vote: 'up' })
			.expect(404);
	});

	test('a project editor can annotate', async () => {
		const teamProject = await createTeamProject();
		await linkUserToProject(member, teamProject, 'project:editor');

		const workflow = await createWorkflow({}, teamProject);
		const execution = await createSuccessfulExecution(workflow);

		await testServer
			.authAgentFor(member)
			.patch(`/executions/${execution.id}`)
			.send({ vote: 'up' })
			.expect(200);
	});

	test('rejects an update carrying no annotation at all', async () => {
		const execution = await saveExecution({ belongingTo: owner });

		await testServer.authAgentFor(owner).patch(`/executions/${execution.id}`).send({}).expect(400);
	});
});

describe('POST /executions/delete', () => {
	test('should hard-delete an execution', async () => {
		await saveExecution({ belongingTo: owner });

		const response = await testServer.authAgentFor(owner).get('/executions').expect(200);

		expect(response.body.data.count).toBe(1);

		const [execution] = response.body.data.results;

		await testServer
			.authAgentFor(owner)
			.post('/executions/delete')
			.send({ ids: [execution.id] })
			.expect(200);

		const executions = await getAllExecutions();

		expect(executions).toHaveLength(0);
	});
});

describe('POST /executions/stop', () => {
	test('should not stop an execution we do not have access to', async () => {
		await saveExecution({ belongingTo: owner });
		const incorrectExecutionId = '1234';

		await testServer
			.authAgentFor(owner)
			.post(`/executions/${incorrectExecutionId}/stop`)
			.expect(400);
	});

	test('should stop an execution we have access to', async () => {
		const execution = await saveWaitingExecution({ belongingTo: owner });

		await testServer.authAgentFor(owner).post(`/executions/${execution.id}/stop`).expect(200);
	});
});
describe('POST /executions/stopMany', () => {
	test('should not stop an execution we do not have access to', async () => {
		await saveWaitingExecution({ belongingTo: owner });

		const result = await testServer
			.authAgentFor(member)
			.post('/executions/stopMany')
			.send({ filter: { status: ['waiting'] } })
			.expect(200);

		expect(result.body.data.stopped).toBe(0);
	});

	test('should stop an execution we have access to', async () => {
		await saveWaitingExecution({ belongingTo: owner });

		const result = await testServer
			.authAgentFor(owner)
			.post('/executions/stopMany')
			.send({ filter: { status: ['waiting'] } })
			.expect(200);

		expect(result.body.data.stopped).toBe(1);
	});
});
