import { createTeamProject, testDb, testModules } from '@n8n/backend-test-utils';
import {
	AgentEvalDatasetRepository,
	AgentEvalResultRepository,
	AgentEvalRunRepository,
	GLOBAL_OWNER_ROLE,
	type AgentEvalRun,
	type User,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { Agent } from '@/modules/agents/entities/agent.entity';
import { createUserShell } from '@test-integration/db/users';

// These transitions run against the real driver because their criteria use
// operators (`In`) inside `update()`, and because `cleanupInterruptedRuns()`
// swallows its own error — a regression here would otherwise surface only as
// runs that poll as `running` forever.

let owner: User;
let runRepository: AgentEvalRunRepository;
let resultRepository: AgentEvalResultRepository;
let datasetRepository: AgentEvalDatasetRepository;

/** Insert a minimal real agent row so `agent_eval_dataset.agentId`'s FK holds. */
async function createAgent(projectId: string): Promise<Agent> {
	return await Container.get(DataSource)
		.getRepository(Agent)
		.save(Object.assign(new Agent(), { name: 'test agent', projectId }));
}

async function createRun(): Promise<AgentEvalRun> {
	const project = await createTeamProject();
	const agent = await createAgent(project.id);
	const dataset = await datasetRepository.createDataset({
		name: 'ds',
		agentId: agent.id,
		datasetSource: 'data_table',
		datasetRef: { dataTableId: 'dt-1' },
		createdById: owner.id,
	});
	return await runRepository.createRun({ datasetId: dataset.id, createdById: owner.id });
}

beforeAll(async () => {
	await testModules.loadModules(['agents']);
	await testDb.init();
	owner = await createUserShell(GLOBAL_OWNER_ROLE);

	runRepository = Container.get(AgentEvalRunRepository);
	resultRepository = Container.get(AgentEvalResultRepository);
	datasetRepository = Container.get(AgentEvalDatasetRepository);
});

beforeEach(async () => {
	await testDb.truncate(['AgentEvalResult', 'AgentEvalRun', 'AgentEvalDataset']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('AgentEvalRunRepository.markAllIncompleteAsError (integration)', () => {
	it('settles only runs left in a non-terminal state', async () => {
		const newRun = await createRun();
		const runningRun = await createRun();
		const settledRun = await createRun();

		await runRepository.markAsRunning(runningRun.id, 'host-1');
		await runRepository.markAsCompleted(settledRun.id, { total: 1 });

		const result = await runRepository.markAllIncompleteAsError();

		expect(result.affected).toBe(2);

		const [after, afterRunning, afterSettled] = await Promise.all([
			runRepository.findOneBy({ id: newRun.id }),
			runRepository.findOneBy({ id: runningRun.id }),
			runRepository.findOneBy({ id: settledRun.id }),
		]);

		expect(after?.status).toBe('error');
		expect(afterRunning?.status).toBe('error');
		// A run that already finished keeps its outcome and its tally.
		expect(afterSettled?.status).toBe('completed');
		expect(afterSettled?.metrics).toEqual({ total: 1 });
	});

	it('reports nothing affected when every run is already settled', async () => {
		const run = await createRun();
		await runRepository.markAsCompleted(run.id);

		const result = await runRepository.markAllIncompleteAsError();

		expect(result.affected).toBe(0);
	});
});

describe('AgentEvalRunRepository.markAsError (integration)', () => {
	it('keeps an existing tally when called without metrics', async () => {
		const run = await createRun();
		await runRepository.markAsRunning(run.id, 'host-1');
		await runRepository.markAsCompleted(run.id, { total: 3 });

		await runRepository.markAsError(run.id, 'run_failed', { message: 'boom' });

		const after = await runRepository.findOneBy({ id: run.id });
		expect(after?.status).toBe('error');
		expect(after?.errorCode).toBe('run_failed');
		expect(after?.metrics).toEqual({ total: 3 });
	});
});

describe('AgentEvalResultRepository.countByStatus (integration)', () => {
	it('zero-fills every status for a run with no results', async () => {
		const run = await createRun();

		const counts = await resultRepository.countByStatus(run.id);

		expect(Object.values(counts).every((count) => count === 0)).toBe(true);
	});

	it('counts each status independently', async () => {
		const run = await createRun();
		const seeded = await resultRepository.seedResults(
			Array.from({ length: 3 }, (_, runIndex) => ({ runId: run.id, runIndex })),
		);

		await resultRepository.markAsCompleted(seeded[0].id, {});
		await resultRepository.markAsError(seeded[1].id, 'empty_input', { message: 'no input' });

		const counts = await resultRepository.countByStatus(run.id);

		expect(counts.success).toBe(1);
		expect(counts.error).toBe(1);
		expect(counts.new).toBe(1);
	});
});
