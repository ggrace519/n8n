import { Column, Entity, ManyToOne, OneToMany, Relation } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import { EvaluationConfig } from './evaluation-config';
import type { TestRun } from './test-run';
import { User } from './user';
import { WorkflowEntity } from './workflow-entity';

/**
 * A named group of test runs for one workflow + evaluation config, used to
 * compare workflow versions against each other (the "compare" surface).
 */
@Entity()
export class EvaluationCollection extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@ManyToOne('WorkflowEntity', { onDelete: 'CASCADE' })
	workflow: Relation<WorkflowEntity>;

	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@ManyToOne('EvaluationConfig', { onDelete: 'CASCADE' })
	evaluationConfig: Relation<EvaluationConfig>;

	@Column({ type: 'varchar', length: 36 })
	evaluationConfigId: string;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	createdBy: Relation<User> | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;

	/**
	 * Cached AI-insights envelope for the collection's current run set, so the
	 * compare view doesn't regenerate insights on every open. Invalidated by
	 * the service when the run set changes.
	 */
	@JsonColumn({ nullable: true })
	insightsCache: IDataObject | null;

	@OneToMany('TestRun', 'collection')
	testRuns: Relation<TestRun[]>;
}
