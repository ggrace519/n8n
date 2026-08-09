import { Column, Entity, ManyToOne, Relation } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import { ExecutionEntity } from './execution-entity';
import { TestRun } from './test-run';
import type { AggregatedTestRunMetrics, TestCaseExecutionErrorCode } from './types-db';
import { idStringifier } from '../utils/transformers';

export type TestCaseExecutionStatus =
	| 'new'
	| 'running'
	| 'evaluation_running'
	| 'success'
	| 'error'
	| 'warning'
	| 'cancelled';

/**
 * Result of running one dataset row through the workflow under test as part
 * of a {@link TestRun}.
 */
@Entity()
export class TestCaseExecution extends WithTimestampsAndStringId {
	@ManyToOne('TestRun', 'testCaseExecutions', { onDelete: 'CASCADE' })
	testRun: Relation<TestRun>;

	@Column({ type: 'varchar', length: 36 })
	testRunId: string;

	/**
	 * Execution of the workflow under test. Null when the execution was
	 * deleted after the run, or the case never started.
	 */
	@ManyToOne('ExecutionEntity', { onDelete: 'SET NULL', nullable: true })
	execution: Relation<ExecutionEntity> | null;

	@Column({ type: 'int', nullable: true, transformer: idStringifier })
	executionId: string | null;

	@Column({ type: 'varchar' })
	status: TestCaseExecutionStatus;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	@Column({ type: 'varchar', nullable: true })
	errorCode: TestCaseExecutionErrorCode | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	@JsonColumn({ nullable: true })
	metrics: AggregatedTestRunMetrics | null;

	@JsonColumn({ nullable: true })
	inputs: IDataObject | null;

	@JsonColumn({ nullable: true })
	outputs: IDataObject | null;

	/**
	 * 0-based index of the dataset row this case executed, so partial runs
	 * (`rowIndices`) map results back to the original dataset rows.
	 */
	@Column({ type: 'int', nullable: true })
	runIndex: number | null;
}
