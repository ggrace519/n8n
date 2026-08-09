import type {
	AgentEvalColumnMapping,
	DataTableDatasetRef,
	GoogleSheetsDatasetRef,
} from '@n8n/api-types';
import { Column, Entity, ManyToOne, Relation } from '@n8n/typeorm';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import { User } from './user';

export type AgentEvalDatasetSource = 'data_table' | 'google_sheets';

/**
 * A set of eval cases for one agent. The cases themselves are not stored here:
 * `datasetSource` + `datasetRef` point at an existing backend (a Data Table or a
 * Google Sheet) and `columnMapping` says which of its columns play the
 * input / expectedOutput / criteria roles.
 *
 * `agentId` is a plain column, not a relation: `Agent` is registered by the
 * `agents` module, so an ORM relation from this always-loaded entity would break
 * TypeORM metadata whenever that module is off. Referential integrity is the
 * migration's FK (`agents.id`, ON DELETE CASCADE).
 */
@Entity()
export class AgentEvalDataset extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@Column({ type: 'varchar', length: 36 })
	agentId: string;

	/** Dataset backend the cases are read from. */
	@Column({ type: 'varchar', length: 32 })
	datasetSource: AgentEvalDatasetSource;

	/** Pointer into that backend; the shape varies by `datasetSource`. */
	@JsonColumn()
	datasetRef: DataTableDatasetRef | GoogleSheetsDatasetRef;

	@JsonColumn({ nullable: true })
	columnMapping: AgentEvalColumnMapping | null;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	createdBy: Relation<User> | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;
}
