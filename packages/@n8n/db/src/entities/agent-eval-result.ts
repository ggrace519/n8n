import type { AgentEvalResultStatus } from '@n8n/api-types';
import { Column, Entity, ManyToOne, Relation } from '@n8n/typeorm';
import type { IDataObject, JsonObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalRun } from './agent-eval-run';

/**
 * One case of an {@link AgentEvalRun}: the input snapshot actually run, the
 * agent's output and tool-call timeline, and the per-case judge scores.
 *
 * `input` is a snapshot rather than a reference because the origin row lives in
 * an external, mutable dataset backend — `sourceRowId` only records where it
 * came from.
 */
@Entity()
export class AgentEvalResult extends WithTimestampsAndStringId {
	@ManyToOne('AgentEvalRun', { onDelete: 'CASCADE' })
	run: Relation<AgentEvalRun>;

	@Column({ type: 'varchar', length: 36 })
	runId: string;

	/** Origin dataset row id; loose pointer, rows are external and mutable. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	sourceRowId: string | null;

	/** Order of this case within the run. */
	@Column({ type: 'int', nullable: true })
	runIndex: number | null;

	@Column({ type: 'varchar' })
	status: AgentEvalResultStatus;

	/** Snapshot of the case input actually run (the row may later change). */
	@JsonColumn({ nullable: true })
	input: JsonObject | null;

	@JsonColumn({ nullable: true })
	output: JsonObject | null;

	/** Tool-call timeline captured during the run. */
	@JsonColumn({ nullable: true })
	toolCalls: JsonObject | null;

	@JsonColumn({ nullable: true })
	metrics: IDataObject | null;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	errorCode: string | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;
}
