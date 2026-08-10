import {
	Column,
	Entity,
	JoinColumn,
	JoinTable,
	ManyToMany,
	ManyToOne,
	OneToMany,
	Relation,
} from '@n8n/typeorm';

import { DateTimeColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { Project } from './project';
import type { User } from './user';
import type { WorkflowReviewRequestWorkflow } from './workflow-review-request-workflow';

/** Lifecycle: `open` requests accept actions, `closed` ones are done. */
export type WorkflowReviewRequestState = 'open' | 'closed';

/** Latest request-level outcome. There is no per-reviewer decision. */
export type WorkflowReviewRequestDecision = 'pending' | 'changes_requested' | 'approved';

@Entity({ name: 'workflow_review_request' })
export class WorkflowReviewRequest extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 36 })
	projectId: string;

	@Column({ type: 'varchar', length: 16, default: 'open' })
	state: WorkflowReviewRequestState;

	@Column({ type: 'varchar', length: 50, default: 'pending' })
	decision: WorkflowReviewRequestDecision;

	@Column({ type: 'varchar', length: 255 })
	title: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;

	@Column({ type: 'uuid', nullable: true })
	updatedById: string | null;

	@Column({ type: 'uuid', nullable: true })
	closedById: string | null;

	@DateTimeColumn({ precision: 3, nullable: true })
	approvedAt: Date | null;

	@ManyToOne('Project', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'projectId' })
	project: Relation<Project>;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	@JoinColumn({ name: 'createdById' })
	createdBy: Relation<User> | null;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	@JoinColumn({ name: 'updatedById' })
	updatedBy: Relation<User> | null;

	@ManyToOne('User', { onDelete: 'SET NULL', nullable: true })
	@JoinColumn({ name: 'closedById' })
	closedBy: Relation<User> | null;

	@OneToMany('WorkflowReviewRequestWorkflow', 'request')
	workflows: Relation<WorkflowReviewRequestWorkflow[]>;

	// Junctions are modelled as join tables rather than entities so that
	// `testDb.truncate(['WorkflowReviewRequest'])` clears them via TypeORM's
	// many-to-many metadata instead of relying on FK cascade.
	@ManyToMany('User')
	@JoinTable({
		name: 'workflow_review_request_reviewers',
		joinColumn: { name: 'workflowReviewRequestId', referencedColumnName: 'id' },
		inverseJoinColumn: { name: 'userId', referencedColumnName: 'id' },
	})
	reviewers: Relation<User[]>;

	@ManyToMany('User')
	@JoinTable({
		name: 'workflow_review_request_authors',
		joinColumn: { name: 'workflowReviewRequestId', referencedColumnName: 'id' },
		inverseJoinColumn: { name: 'userId', referencedColumnName: 'id' },
	})
	authors: Relation<User[]>;
}
