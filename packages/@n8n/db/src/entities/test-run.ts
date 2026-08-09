import { Column, Entity, ManyToOne, OneToMany, Relation } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { EvaluationCollection } from './evaluation-collection';
import type { EvaluationConfig } from './evaluation-config';
import type { TestCaseExecution } from './test-case-execution';
import type { AggregatedTestRunMetrics, TestRunErrorCode, TestRunFinalResult } from './types-db';
import { WorkflowEntity } from './workflow-entity';

export type TestRunStatus = 'new' | 'running' | 'completed' | 'error' | 'cancelled';

/**
 * One evaluation run of a workflow: dataset rows are fed through the workflow
 * under test and each row's result is stored as a {@link TestCaseExecution}.
 * Aggregated metrics land on `metrics` when the run completes.
 */
@Entity()
export class TestRun extends WithTimestampsAndStringId {
	@ManyToOne('WorkflowEntity', { onDelete: 'CASCADE' })
	workflow: Relation<WorkflowEntity>;

	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@Column({ type: 'varchar' })
	status: TestRunStatus;

	@Column({ type: 'varchar', nullable: true })
	errorCode: TestRunErrorCode | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	@JsonColumn({ nullable: true })
	metrics: AggregatedTestRunMetrics | null;

	/**
	 * Main instance currently executing this run. Lets other mains route a
	 * cancel request (pubsub `cancel-test-run`) to the right instance.
	 */
	@Column({ type: 'varchar', length: 255, nullable: true })
	runningInstanceId: string | null;

	/**
	 * Cross-instance cancellation flag: set by the instance that received the
	 * cancel request; polled by the instance running the test.
	 */
	@Column({ type: Boolean, default: false })
	cancelRequested: boolean;

	/**
	 * Workflow-history version the run executed. No FK — history rows can be
	 * pruned by retention while runs keep the reference for auditability.
	 */
	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowVersionId: string | null;

	@ManyToOne('EvaluationConfig', { onDelete: 'SET NULL', nullable: true })
	evaluationConfig: Relation<EvaluationConfig> | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	evaluationConfigId: string | null;

	/**
	 * Frozen copy of the evaluation config at run start, so results always
	 * normalize against the config they were produced with, even after the
	 * live config changes or is deleted.
	 */
	@JsonColumn({ nullable: true })
	evaluationConfigSnapshot: IDataObject | null;

	@ManyToOne('EvaluationCollection', 'testRuns', { onDelete: 'SET NULL', nullable: true })
	collection: Relation<EvaluationCollection> | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	collectionId: string | null;

	@OneToMany('TestCaseExecution', 'testRun')
	testCaseExecutions: Relation<TestCaseExecution[]>;

	/**
	 * Overall outcome derived from the per-case statuses of a completed run.
	 * Not a column: repositories populate it on summary reads (it must be an
	 * own property — callers spread summaries, which would drop a getter).
	 */
	finalResult?: TestRunFinalResult | null;
}
