import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	undoLastSingleMigration,
	type TestMigrationContext,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

const MIGRATION_NAME = 'AddOpenWorkflowSentinelToWorkflowReviews1785913150000';

const REQUEST_TABLE = 'workflow_review_request';
const LINK_TABLE = 'workflow_review_request_workflow';

/**
 * The DDL half of this migration is covered by the schema-doc diff; what is
 * exercised here is the data half — the duplicate resolution and backfill that
 * run against rows an already-live instance may hold, and which can close
 * reviews.
 */
describe('AddOpenWorkflowSentinelToWorkflowReviews Migration', () => {
	let dataSource: DataSource;

	beforeEach(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.init();
		dataSource = Container.get(DataSource);
		const ctx = createTestMigrationContext(dataSource);
		await ctx.queryRunner.clearDatabase();
		await ctx.queryRunner.release();
		await initDbUpToMigration(MIGRATION_NAME);
	});

	afterEach(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.close();
	});

	async function insertProject(ctx: TestMigrationContext, id: string): Promise<void> {
		const table = ctx.escape.tableName('project');
		await ctx.runQuery(
			`INSERT INTO ${table} ("id", "name", "type", "createdAt", "updatedAt") VALUES (:id, :name, :type, :createdAt, :updatedAt)`,
			{ id, name: `Project ${id}`, type: 'team', createdAt: new Date(), updatedAt: new Date() },
		);
	}

	async function insertWorkflow(ctx: TestMigrationContext, id: string): Promise<void> {
		const table = ctx.escape.tableName('workflow_entity');
		await ctx.runQuery(
			`INSERT INTO ${table} ("id", "name", "active", "nodes", "connections", "versionId", "createdAt", "updatedAt") VALUES (:id, :name, :active, :nodes, :connections, :versionId, :createdAt, :updatedAt)`,
			{
				id,
				name: `Workflow ${id}`,
				active: false,
				nodes: '[]',
				connections: '{}',
				versionId: randomUUID(),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		);
	}

	async function insertRequest(
		ctx: TestMigrationContext,
		{
			id,
			projectId,
			state,
			createdAt,
		}: { id: string; projectId: string; state: 'open' | 'closed'; createdAt: Date },
	): Promise<void> {
		const table = ctx.escape.tableName(REQUEST_TABLE);
		await ctx.runQuery(
			`INSERT INTO ${table} ("id", "projectId", "state", "decision", "title", "createdAt", "updatedAt") VALUES (:id, :projectId, :state, :decision, :title, :createdAt, :updatedAt)`,
			{
				id,
				projectId,
				state,
				decision: 'pending',
				title: `Review ${id}`,
				createdAt,
				updatedAt: createdAt,
			},
		);
	}

	async function insertLink(
		ctx: TestMigrationContext,
		{ id, requestId, workflowId }: { id: string; requestId: string; workflowId: string },
	): Promise<void> {
		const table = ctx.escape.tableName(LINK_TABLE);
		await ctx.runQuery(
			`INSERT INTO ${table} ("id", "workflowReviewRequestId", "workflowId") VALUES (:id, :requestId, :workflowId)`,
			{ id, requestId, workflowId },
		);
	}

	/**
	 * Two open reviews on one workflow plus a closed one — the state the
	 * unenforced check-then-insert could leave behind.
	 */
	async function seedDuplicates(): Promise<{
		newerOpenId: string;
		olderOpenId: string;
		closedId: string;
		workflowId: string;
	}> {
		const projectId = randomUUID();
		const workflowId = randomUUID();
		const newerOpenId = randomUUID();
		const olderOpenId = randomUUID();
		const closedId = randomUUID();

		const ctx = createTestMigrationContext(dataSource);
		await insertProject(ctx, projectId);
		await insertWorkflow(ctx, workflowId);
		await insertRequest(ctx, {
			id: olderOpenId,
			projectId,
			state: 'open',
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
		});
		await insertRequest(ctx, {
			id: newerOpenId,
			projectId,
			state: 'open',
			createdAt: new Date('2026-02-01T00:00:00.000Z'),
		});
		await insertRequest(ctx, {
			id: closedId,
			projectId,
			state: 'closed',
			createdAt: new Date('2026-01-15T00:00:00.000Z'),
		});
		await insertLink(ctx, { id: randomUUID(), requestId: olderOpenId, workflowId });
		await insertLink(ctx, { id: randomUUID(), requestId: newerOpenId, workflowId });
		await insertLink(ctx, { id: randomUUID(), requestId: closedId, workflowId });
		await ctx.queryRunner.release();

		return { newerOpenId, olderOpenId, closedId, workflowId };
	}

	async function readState(
		ctx: TestMigrationContext,
	): Promise<Map<string, { state: string; openWorkflowId: string | null }>> {
		const rows = await ctx.runQuery<
			Array<{ id: string; state: string; openWorkflowId: string | null }>
		>(
			`SELECT r."id" AS "id", r."state" AS "state", l."openWorkflowId" AS "openWorkflowId"
			FROM ${ctx.escape.tableName(REQUEST_TABLE)} r
			INNER JOIN ${ctx.escape.tableName(LINK_TABLE)} l ON l."workflowReviewRequestId" = r."id"`,
		);
		return new Map(
			rows.map((row) => [row.id, { state: row.state, openWorkflowId: row.openWorkflowId }]),
		);
	}

	describe('up', () => {
		it('should keep the newest open review and close the older duplicate', async () => {
			const { newerOpenId, olderOpenId, closedId, workflowId } = await seedDuplicates();

			await runSingleMigration(MIGRATION_NAME);
			dataSource = Container.get(DataSource);

			const ctx = createTestMigrationContext(dataSource);
			const byId = await readState(ctx);
			await ctx.queryRunner.release();

			expect(byId.get(newerOpenId)).toEqual({ state: 'open', openWorkflowId: workflowId });
			expect(byId.get(olderOpenId)).toEqual({ state: 'closed', openWorkflowId: null });
			expect(byId.get(closedId)).toEqual({ state: 'closed', openWorkflowId: null });
		});

		it('should reject a second open sentinel for the same workflow afterwards', async () => {
			const { workflowId } = await seedDuplicates();

			await runSingleMigration(MIGRATION_NAME);
			dataSource = Container.get(DataSource);

			const ctx = createTestMigrationContext(dataSource);
			await expect(
				ctx.runQuery(
					`INSERT INTO ${ctx.escape.tableName(LINK_TABLE)} ("id", "workflowReviewRequestId", "workflowId", "openWorkflowId")
					SELECT :id, "workflowReviewRequestId", "workflowId", "workflowId"
					FROM ${ctx.escape.tableName(LINK_TABLE)} WHERE "openWorkflowId" = :workflowId`,
					{ id: randomUUID(), workflowId },
				),
			).rejects.toThrow();
			await ctx.queryRunner.release();
		});

		it('should leave several closed reviews of one workflow untouched', async () => {
			const projectId = randomUUID();
			const workflowId = randomUUID();
			const first = randomUUID();
			const second = randomUUID();

			const seed = createTestMigrationContext(dataSource);
			await insertProject(seed, projectId);
			await insertWorkflow(seed, workflowId);
			for (const id of [first, second]) {
				await insertRequest(seed, { id, projectId, state: 'closed', createdAt: new Date() });
				await insertLink(seed, { id: randomUUID(), requestId: id, workflowId });
			}
			await seed.queryRunner.release();

			await runSingleMigration(MIGRATION_NAME);
			dataSource = Container.get(DataSource);

			// NULLs are distinct in a unique index on both drivers, so any number of
			// closed reviews of one workflow coexist.
			const ctx = createTestMigrationContext(dataSource);
			const byId = await readState(ctx);
			await ctx.queryRunner.release();

			expect(byId.get(first)).toEqual({ state: 'closed', openWorkflowId: null });
			expect(byId.get(second)).toEqual({ state: 'closed', openWorkflowId: null });
		});
	});

	describe('down', () => {
		it('should drop the column and keep the rows, keys and other indexes', async () => {
			const { newerOpenId, olderOpenId, workflowId } = await seedDuplicates();

			await runSingleMigration(MIGRATION_NAME);
			dataSource = Container.get(DataSource);
			await undoLastSingleMigration(MIGRATION_NAME);
			dataSource = Container.get(DataSource);

			const ctx = createTestMigrationContext(dataSource);
			const linkTable = ctx.escape.tableName(LINK_TABLE);

			const rows = await ctx.runQuery<Array<{ id: string; workflowId: string }>>(
				`SELECT "id", "workflowId" FROM ${linkTable}`,
			);
			expect(rows).toHaveLength(3);
			expect(rows.every((row) => row.workflowId === workflowId)).toBe(true);

			// The duplicate resolution is not undone: reopening a review the
			// migration closed would recreate the state the constraint forbids.
			const byId = await ctx.runQuery<Array<{ id: string; state: string }>>(
				`SELECT "id", "state" FROM ${ctx.escape.tableName(REQUEST_TABLE)}`,
			);
			expect(byId.find((row) => row.id === newerOpenId)?.state).toBe('open');
			expect(byId.find((row) => row.id === olderOpenId)?.state).toBe('closed');

			// The SQLite rebuild in `dropColumns` is where the surviving unique
			// index and foreign keys silently disappear.
			const duplicatePair = ctx.runQuery(
				`INSERT INTO ${linkTable} ("id", "workflowReviewRequestId", "workflowId")
				SELECT :id, "workflowReviewRequestId", "workflowId" FROM ${linkTable} WHERE "id" = (
					SELECT "id" FROM ${linkTable} ORDER BY "id" LIMIT 1
				)`,
				{ id: randomUUID() },
			);
			await expect(duplicatePair).rejects.toThrow();

			const danglingWorkflow = ctx.runQuery(
				`INSERT INTO ${linkTable} ("id", "workflowReviewRequestId", "workflowId") VALUES (:id, :requestId, :workflowId)`,
				{ id: randomUUID(), requestId: newerOpenId, workflowId: randomUUID() },
			);
			await expect(danglingWorkflow).rejects.toThrow();

			await ctx.queryRunner.release();
		});
	});
});
