import type { MigrationContext, ReversibleMigration } from '../migration-types';

const REQUEST_TABLE = 'workflow_review_request';
const WORKFLOW_TABLE = 'workflow_review_request_workflow';
const COLUMN = 'openWorkflowId';
const UQ_OPEN_WORKFLOW = 'workflow_review_request_workflow_open_workflow';

/**
 * Adds the sentinel that enforces "at most one open review per workflow" at the
 * database boundary. It holds `workflowId` while the parent request is open and
 * is NULL once the request closes; a plain unique constraint over the nullable
 * column then rejects a second open review portably (SQLite and Postgres both
 * treat NULLs as distinct), where a partial unique index would not be.
 *
 * Until now the invariant was a check-then-insert in application code, so an
 * existing database may already hold duplicates. Those are resolved before the
 * constraint is created: the newest open request per workflow keeps the
 * sentinel and stays open, older ones are closed. Closing the newer one instead
 * would drop the most recent reviewer state on the floor.
 */
export class AddOpenWorkflowSentinelToWorkflowReviews1785913150000 implements ReversibleMigration {
	async up(context: MigrationContext) {
		await this.addColumn(context);
		await this.closeDuplicateOpenRequests(context);
		await this.backfillSentinel(context);
		await this.createUniqueConstraint(context);
	}

	async down({ schemaBuilder: { dropColumns }, runQuery, tablePrefix }: MigrationContext) {
		await runQuery(`DROP INDEX IF EXISTS ${this.uniqueIndexName(tablePrefix)}`);
		await dropColumns(WORKFLOW_TABLE, [COLUMN], { recreatesOnSqlite: true });
	}

	private uniqueIndexName(tablePrefix: string): string {
		return `"UQ_${tablePrefix}${UQ_OPEN_WORKFLOW}"`;
	}

	/** Nullable, so a raw ALTER avoids the SQLite table rebuild. */
	private async addColumn({ runQuery, escape, isPostgres }: MigrationContext) {
		const table = escape.tableName(WORKFLOW_TABLE);
		const column = escape.columnName(COLUMN);
		await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} varchar(36)`);

		if (isPostgres) {
			await runQuery(
				`COMMENT ON COLUMN ${table}.${column} IS ` +
					"'Holds workflowId while the parent review request is open, NULL once closed; " +
					"uniquely constrained so a workflow can have at most one open review'",
			);
		}
	}

	private async closeDuplicateOpenRequests({ runQuery, escape }: MigrationContext) {
		const requestTable = escape.tableName(REQUEST_TABLE);
		const linkTable = escape.tableName(WORKFLOW_TABLE);
		const requestIdColumn = escape.columnName('workflowReviewRequestId');
		const workflowIdColumn = escape.columnName('workflowId');
		const stateColumn = escape.columnName('state');
		const createdAtColumn = escape.columnName('createdAt');
		const idColumn = escape.columnName('id');

		// A request loses when another open request on the same workflow is newer
		// on (createdAt, id) — the same total order the inbox pages by.
		await runQuery(
			`UPDATE ${requestTable} SET ${stateColumn} = 'closed'
			WHERE ${stateColumn} = 'open' AND ${idColumn} IN (
				SELECT r.${idColumn} FROM ${requestTable} r
				INNER JOIN ${linkTable} l ON l.${requestIdColumn} = r.${idColumn}
				INNER JOIN ${linkTable} l2 ON l2.${workflowIdColumn} = l.${workflowIdColumn}
					AND l2.${requestIdColumn} <> r.${idColumn}
				INNER JOIN ${requestTable} r2 ON r2.${idColumn} = l2.${requestIdColumn}
					AND r2.${stateColumn} = 'open'
				WHERE r.${stateColumn} = 'open'
					AND (r2.${createdAtColumn} > r.${createdAtColumn}
						OR (r2.${createdAtColumn} = r.${createdAtColumn} AND r2.${idColumn} > r.${idColumn}))
			)`,
		);
	}

	private async backfillSentinel({ runQuery, escape }: MigrationContext) {
		const requestTable = escape.tableName(REQUEST_TABLE);
		const linkTable = escape.tableName(WORKFLOW_TABLE);
		const column = escape.columnName(COLUMN);
		const requestIdColumn = escape.columnName('workflowReviewRequestId');
		const workflowIdColumn = escape.columnName('workflowId');
		const stateColumn = escape.columnName('state');
		const idColumn = escape.columnName('id');

		// Without this, an already-open review is unprotected and its eventual
		// closure clears nothing, so a second open review could still be created.
		await runQuery(
			`UPDATE ${linkTable} SET ${column} = ${workflowIdColumn}
			WHERE ${requestIdColumn} IN (
				SELECT ${idColumn} FROM ${requestTable} WHERE ${stateColumn} = 'open'
			)`,
		);
	}

	private async createUniqueConstraint({ runQuery, escape, tablePrefix }: MigrationContext) {
		await runQuery(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${this.uniqueIndexName(tablePrefix)}
			ON ${escape.tableName(WORKFLOW_TABLE)}(${escape.columnName(COLUMN)})`,
		);
	}
}
