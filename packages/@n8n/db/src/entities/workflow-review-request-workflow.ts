import { Column, Entity, JoinColumn, ManyToOne, Relation } from '@n8n/typeorm';

import { WithStringId } from './abstract-entity';
import type { WorkflowEntity } from './workflow-entity';
import type { WorkflowHistory } from './workflow-history';
import type { WorkflowReviewRequest } from './workflow-review-request';

/**
 * One workflow under review, with the workflow-history version pinned for it.
 *
 * `workflowVersionId` is nullable on purpose: pruning a closed review's history
 * leaves the review row intact and clears the pin (FK `ON DELETE SET NULL`).
 */
@Entity({ name: 'workflow_review_request_workflow' })
export class WorkflowReviewRequestWorkflow extends WithStringId {
	@Column({ type: 'varchar', length: 36 })
	workflowReviewRequestId: string;

	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowVersionId: string | null;

	/**
	 * Enforcement sentinel for "at most one open review per workflow": carries
	 * `workflowId` while the parent request is open, and is cleared on closure.
	 * A unique constraint over a nullable column is portable — SQLite and
	 * Postgres both treat NULLs as distinct — where a partial unique index is not.
	 *
	 * Enforcement only. "Is this review open?" is always answered from
	 * `WorkflowReviewRequest.state`; deriving it from here would create a second
	 * source of truth whose drift blocks legitimate publication.
	 */
	@Column({ type: 'varchar', length: 36, nullable: true })
	openWorkflowId: string | null;

	@ManyToOne('WorkflowReviewRequest', 'workflows', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'workflowReviewRequestId' })
	request: Relation<WorkflowReviewRequest>;

	@ManyToOne('WorkflowEntity', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'workflowId' })
	workflow: Relation<WorkflowEntity>;

	@ManyToOne('WorkflowHistory', { onDelete: 'SET NULL', nullable: true })
	@JoinColumn({ name: 'workflowVersionId', referencedColumnName: 'versionId' })
	workflowVersion: Relation<WorkflowHistory> | null;
}
