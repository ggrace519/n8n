import type { DataTableDatasetRef, EvaluationMetric, GoogleSheetsDatasetRef } from '@n8n/api-types';
import { Column, Entity, ManyToOne, Relation, Unique } from '@n8n/typeorm';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import { WorkflowEntity } from './workflow-entity';

export type EvaluationConfigStatus = 'valid' | 'invalid';
export type EvaluationDatasetSource = 'data_table' | 'google_sheets';

/**
 * A saved, workflow-scoped evaluation setup: which dataset to feed in, the
 * segment of the workflow to exercise (start/end node), and the metrics to
 * score each case with. The structured `datasetRef`/`metrics` payloads are
 * validated against the `@n8n/api-types` zod schemas before they reach the
 * persistence layer, which stores them as JSON.
 */
@Entity()
@Unique(['workflowId', 'name'])
export class EvaluationConfig extends WithTimestampsAndStringId {
	@ManyToOne('WorkflowEntity', { onDelete: 'CASCADE' })
	workflow: Relation<WorkflowEntity>;

	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'varchar', length: 16, default: 'valid' })
	status: EvaluationConfigStatus;

	/** Why the config no longer applies to the workflow (e.g. a node was renamed). */
	@Column({ type: 'varchar', length: 64, nullable: true })
	invalidReason: string | null;

	@Column({ type: 'varchar', length: 32 })
	datasetSource: EvaluationDatasetSource;

	@JsonColumn()
	datasetRef: DataTableDatasetRef | GoogleSheetsDatasetRef;

	@Column({ type: 'varchar', length: 255 })
	startNodeName: string;

	@Column({ type: 'varchar', length: 255 })
	endNodeName: string;

	@JsonColumn()
	metrics: EvaluationMetric[];
}
