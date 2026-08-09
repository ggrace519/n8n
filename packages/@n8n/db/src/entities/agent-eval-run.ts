import type { AgentEvalRunStatus } from '@n8n/api-types';
import { Column, Entity, ManyToOne, Relation } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalDataset } from './agent-eval-dataset';
import { User } from './user';

/**
 * One execution of an agent-eval dataset: every case is run against the agent
 * and captured as an {@link AgentEvalResult}, with the per-status tally landing
 * on `metrics` once the run settles.
 *
 * The agent under test comes from the dataset, so a run carries no agentId of
 * its own — agent-scoped reads filter through the `dataset` relation.
 */
@Entity()
export class AgentEvalRun extends WithTimestampsAndStringId {
	@ManyToOne('AgentEvalDataset', { onDelete: 'CASCADE' })
	dataset: Relation<AgentEvalDataset>;

	@Column({ type: 'varchar', length: 36 })
	datasetId: string;

	/**
	 * Published agent version under test (`agent_history.versionId`). Loose
	 * pointer with no FK so runs survive history pruning, mirroring
	 * `TestRun.workflowVersionId`.
	 */
	@Column({ type: 'varchar', length: 36, nullable: true })
	agentVersionId: string | null;

	@Column({ type: 'varchar' })
	status: AgentEvalRunStatus;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	/** Aggregated run-level scores. */
	@JsonColumn({ nullable: true })
	metrics: IDataObject | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	errorCode: string | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	/** Main instance executing this run; used to coordinate cancellation. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	runningInstanceId: string | null;

	/** Fallback cancellation flag polled by the running main. */
	@Column({ type: Boolean, default: false })
	cancelRequested: boolean;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	createdBy: Relation<User> | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;
}
