import type { AgentEvalVote } from '@n8n/api-types';
import { Column, Entity, ManyToOne, Relation } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalResult } from './agent-eval-result';
import { User } from './user';

/**
 * A human's 👍/👎 on one {@link AgentEvalResult}, optionally with a comment and a
 * corrected answer. Ratings are append-only: re-voting adds a row, so the
 * superseded verdict (and its correction) stays on record for calibration.
 */
@Entity()
export class AgentEvalRating extends WithTimestampsAndStringId {
	@ManyToOne('AgentEvalResult', { onDelete: 'CASCADE' })
	result: Relation<AgentEvalResult>;

	@Column({ type: 'varchar', length: 36 })
	resultId: string;

	@Column({ type: 'varchar', length: 8 })
	vote: AgentEvalVote;

	@Column({ type: 'text', nullable: true })
	comment: string | null;

	/** Corrected/edited output supplied by the rater. */
	@JsonColumn({ nullable: true })
	correction: JsonObject | null;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	ratedBy: Relation<User> | null;

	@Column({ type: 'uuid', nullable: true })
	ratedById: string | null;
}
