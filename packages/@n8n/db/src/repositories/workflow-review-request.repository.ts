import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';
import type { SelectQueryBuilder } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { ProjectRelation } from '../entities/project-relation';
import { SharedWorkflow } from '../entities/shared-workflow';
import { User } from '../entities/user';
import {
	WorkflowReviewRequest,
	type WorkflowReviewRequestDecision,
	type WorkflowReviewRequestState,
} from '../entities/workflow-review-request';
import { WorkflowReviewRequestWorkflow } from '../entities/workflow-review-request-workflow';
import type { OperationContext } from '../services/transaction';

/**
 * Which workflows a caller may see reviews for. `all` is the global-scope
 * shortcut; `scoped` is resolved by role slugs so a project setting that removes
 * a scope is honoured, rather than checking role names in business logic.
 */
export type WorkflowReviewAccessFilter =
	| { kind: 'all' }
	| {
			kind: 'scoped';
			userId: string;
			projectRoleSlugs: string[];
			workflowRoleSlugs: string[];
	  };

export type CreateWorkflowReviewRequestInput = {
	projectId: string;
	title: string;
	createdById: string | null;
	description?: string | null;
	state?: WorkflowReviewRequestState;
	decision?: WorkflowReviewRequestDecision;
};

/** Keyset page position: newest-first on `(createdAt, id)`. */
export type WorkflowReviewInboxCursor = { createdAt: Date; id: string };

@Service()
export class WorkflowReviewRequestRepository extends BaseRepository<WorkflowReviewRequest> {
	constructor(dataSource: DataSource) {
		super(WorkflowReviewRequest, dataSource.manager);
	}

	async createRequest(
		input: CreateWorkflowReviewRequestInput,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequest> {
		const manager = this.managerFor(ctx);
		const request = manager.create(WorkflowReviewRequest, {
			projectId: input.projectId,
			title: input.title,
			description: input.description ?? null,
			createdById: input.createdById,
			updatedById: input.createdById,
			state: input.state ?? 'open',
			decision: input.decision ?? 'pending',
			approvedAt: null,
			closedById: null,
		});
		return await manager.save(WorkflowReviewRequest, request);
	}

	/**
	 * The single open request for a workflow, if any. Read from `request.state`,
	 * never from the open sentinel: the sentinel exists to enforce the invariant,
	 * and a second source of truth for "is this open" would drift towards
	 * blocking publication.
	 */
	async findOpenRequestForWorkflow(
		workflowId: string,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequest | null> {
		return await this.managerFor(ctx)
			.createQueryBuilder(WorkflowReviewRequest, 'request')
			.innerJoin(WorkflowReviewRequestWorkflow, 'link', 'link.workflowReviewRequestId = request.id')
			.where('link.workflowId = :workflowId', { workflowId })
			.andWhere('request.state = :state', { state: 'open' })
			.orderBy('request.createdAt', 'DESC')
			.addOrderBy('request.id', 'DESC')
			.getOne();
	}

	/** Full aggregate for the detail endpoint. */
	async findRequestWithRelations(
		id: string,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequest | null> {
		return await this.managerFor(ctx).findOne(WorkflowReviewRequest, {
			where: { id },
			relations: {
				workflows: true,
				reviewers: true,
				authors: true,
				createdBy: true,
				closedBy: true,
			},
		});
	}

	/**
	 * Newest-first page of the reviews for one workflow, plus the total.
	 * Newest-first is load-bearing: the canvas status sync asks for `take: 1` and
	 * treats the first row as the latest review.
	 */
	async listForWorkflow(
		{
			workflowId,
			state,
			take,
			skip,
		}: { workflowId: string; state?: WorkflowReviewRequestState; take?: number; skip?: number },
		ctx: OperationContext,
	): Promise<{ count: number; data: WorkflowReviewRequest[] }> {
		const query = this.managerFor(ctx)
			.createQueryBuilder(WorkflowReviewRequest, 'request')
			.innerJoin(WorkflowReviewRequestWorkflow, 'link', 'link.workflowReviewRequestId = request.id')
			.leftJoinAndSelect('request.workflows', 'workflows')
			.leftJoinAndSelect('request.closedBy', 'closedBy')
			.where('link.workflowId = :workflowId', { workflowId });

		if (state) {
			query.andWhere('request.state = :state', { state });
		}

		const count = await query.getCount();

		query.orderBy('request.createdAt', 'DESC').addOrderBy('request.id', 'DESC');
		if (take !== undefined) query.take(take);
		if (skip !== undefined) query.skip(skip);

		return { count, data: await query.getMany() };
	}

	/** Inbox totals per state, restricted to workflows the caller may read. */
	async countInboxByState(
		access: WorkflowReviewAccessFilter,
		ctx: OperationContext,
	): Promise<{ open: number; closed: number }> {
		const rows = await this.applyAccessFilter(
			this.managerFor(ctx)
				.createQueryBuilder(WorkflowReviewRequest, 'request')
				.select('request.state', 'state')
				.addSelect('COUNT(DISTINCT request.id)', 'count')
				.groupBy('request.state'),
			access,
		).getRawMany<{ state: WorkflowReviewRequestState; count: string | number }>();

		const totals = { open: 0, closed: 0 };
		for (const row of rows) {
			totals[row.state] = Number(row.count);
		}
		return totals;
	}

	/**
	 * Newest-first keyset page of the inbox. Fetches `limit + 1` so the caller can
	 * report `hasMore` without a second count query.
	 */
	async listInboxPage(
		{
			access,
			state,
			limit,
			cursor,
		}: {
			access: WorkflowReviewAccessFilter;
			state: WorkflowReviewRequestState;
			limit: number;
			cursor?: WorkflowReviewInboxCursor;
		},
		ctx: OperationContext,
	): Promise<WorkflowReviewRequest[]> {
		const query = this.applyAccessFilter(
			this.managerFor(ctx)
				.createQueryBuilder(WorkflowReviewRequest, 'request')
				.leftJoinAndSelect('request.workflows', 'workflows')
				.leftJoinAndSelect('request.reviewers', 'reviewers')
				.leftJoinAndSelect('request.createdBy', 'createdBy')
				.where('request.state = :state', { state }),
			access,
		);

		if (cursor) {
			// Strict keyset on the same (createdAt DESC, id DESC) order the page uses.
			query.andWhere(
				'(request.createdAt < :cursorCreatedAt OR (request.createdAt = :cursorCreatedAt AND request.id < :cursorId))',
				{ cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
			);
		}

		return await query
			.orderBy('request.createdAt', 'DESC')
			.addOrderBy('request.id', 'DESC')
			.take(limit + 1)
			.getMany();
	}

	/**
	 * Conditional transition: applies only while the request is still `open` and
	 * still carries `expectedDecision`. Returns the number of rows changed, so a
	 * caller can map `0` to a conflict instead of silently overwriting a decision
	 * another reviewer already made.
	 */
	async applyDecisionIfOpen(
		{
			id,
			expectedDecision,
			decision,
			actorId,
			close,
			approvedAt,
		}: {
			id: string;
			expectedDecision: WorkflowReviewRequestDecision;
			decision: WorkflowReviewRequestDecision;
			actorId: string;
			close: boolean;
			approvedAt: Date | null;
		},
		ctx: OperationContext,
	): Promise<number> {
		const result = await this.managerFor(ctx).update(
			WorkflowReviewRequest,
			{ id, state: 'open', decision: expectedDecision },
			{
				decision,
				updatedById: actorId,
				updatedAt: new Date(),
				...(close ? { state: 'closed', closedById: actorId } : {}),
				...(approvedAt ? { approvedAt } : {}),
			},
		);
		return result.affected ?? 0;
	}

	/**
	 * Records a new pin on an open request. A `changes_requested` review returns
	 * to `pending`: the author has answered the request for changes.
	 */
	async markUpdatedIfOpen(
		{ id, actorId }: { id: string; actorId: string },
		ctx: OperationContext,
	): Promise<number> {
		const result = await this.managerFor(ctx).update(
			WorkflowReviewRequest,
			{ id, state: 'open' },
			{ decision: 'pending', updatedById: actorId, updatedAt: new Date() },
		);
		return result.affected ?? 0;
	}

	/**
	 * Closes every open review linked to a workflow, for lifecycle events
	 * (archive, transfer, delete). Returns the ids closed so the caller can
	 * broadcast invalidation only when something actually changed.
	 */
	async closeOpenRequestsForWorkflows(
		{ workflowIds, actorId }: { workflowIds: string[]; actorId: string | null },
		ctx: OperationContext,
	): Promise<string[]> {
		if (workflowIds.length === 0) return [];

		const manager = this.managerFor(ctx);
		const openRequests = await manager
			.createQueryBuilder(WorkflowReviewRequest, 'request')
			.select('request.id', 'id')
			.innerJoin(WorkflowReviewRequestWorkflow, 'link', 'link.workflowReviewRequestId = request.id')
			.where('link.workflowId IN (:...workflowIds)', { workflowIds })
			.andWhere('request.state = :state', { state: 'open' })
			.getRawMany<{ id: string }>();

		const ids = [...new Set(openRequests.map((row) => row.id))];
		if (ids.length === 0) return [];

		// Sentinel first, request row second: the module's single lock order (link
		// row before request row). Clearing it releases the workflow for a new
		// review; leaving it set would block every future review of that workflow.
		await manager.update(
			WorkflowReviewRequestWorkflow,
			{ workflowReviewRequestId: In(ids) },
			{ openWorkflowId: null },
		);

		// The decision is left as-is: closing for a lifecycle event is not a
		// reviewer verdict, so it must not read as one.
		await manager.update(
			WorkflowReviewRequest,
			{ id: In(ids), state: 'open' },
			{ state: 'closed', closedById: actorId, updatedAt: new Date() },
		);
		return ids;
	}

	/**
	 * Deletes review requests that no longer link any workflow, cascading their
	 * child and junction rows. Such a request is unreachable: every read path
	 * joins the link table.
	 *
	 * Safe against a create in flight because a request row and its link row are
	 * inserted in one transaction, so a linkless request is never visible to
	 * another connection.
	 */
	async deleteLinklessRequests(ctx: OperationContext): Promise<number> {
		const manager = this.managerFor(ctx);
		const query = manager
			.createQueryBuilder(WorkflowReviewRequest, 'request')
			.select('request.id', 'id');

		const linkExists = query
			.subQuery()
			.select('1')
			.from(WorkflowReviewRequestWorkflow, 'link')
			.where('link.workflowReviewRequestId = request.id')
			.getQuery();

		const rows = await query.where(`NOT EXISTS ${linkExists}`).getRawMany<{ id: string }>();
		if (rows.length === 0) return 0;

		const result = await manager.delete(WorkflowReviewRequest, {
			id: In(rows.map((row) => row.id)),
		});
		return result.affected ?? 0;
	}

	/** Replaces the reviewer junction for a request. */
	async setReviewers(
		{ id, userIds }: { id: string; userIds: string[] },
		ctx: OperationContext,
	): Promise<void> {
		await this.replaceJunction({ id, userIds, relation: 'reviewers' }, ctx);
	}

	/** Replaces the author junction for a request. */
	async setAuthors(
		{ id, userIds }: { id: string; userIds: string[] },
		ctx: OperationContext,
	): Promise<void> {
		await this.replaceJunction({ id, userIds, relation: 'authors' }, ctx);
	}

	private async replaceJunction(
		{ id, userIds, relation }: { id: string; userIds: string[]; relation: 'reviewers' | 'authors' },
		ctx: OperationContext,
	): Promise<void> {
		const manager = this.managerFor(ctx);
		const request = await manager.findOne(WorkflowReviewRequest, {
			where: { id },
			relations: { [relation]: true },
		});
		if (!request) return;

		const users =
			userIds.length > 0
				? await manager.find(User, { where: { id: In([...new Set(userIds)]) } })
				: [];

		await manager
			.createQueryBuilder()
			.relation(WorkflowReviewRequest, relation)
			.of(request)
			.addAndRemove(users, request[relation] ?? []);
	}

	private applyAccessFilter(
		query: SelectQueryBuilder<WorkflowReviewRequest>,
		access: WorkflowReviewAccessFilter,
	): SelectQueryBuilder<WorkflowReviewRequest> {
		if (access.kind === 'all') return query;

		// No role can satisfy the scope: the caller sees nothing rather than everything.
		if (access.projectRoleSlugs.length === 0 || access.workflowRoleSlugs.length === 0) {
			return query.andWhere('1 = 0');
		}

		// Built through the query builder rather than raw SQL so table names,
		// identifier quoting and the table prefix stay the driver's business.
		const accessibleLink = query
			.subQuery()
			.select('1')
			.from(WorkflowReviewRequestWorkflow, 'link')
			.innerJoin(SharedWorkflow, 'sw', 'sw.workflowId = link.workflowId')
			.innerJoin(ProjectRelation, 'pr', 'pr.projectId = sw.projectId')
			.where('link.workflowReviewRequestId = request.id')
			.andWhere('sw.role IN (:...workflowRoleSlugs)')
			.andWhere('pr.role IN (:...projectRoleSlugs)')
			.andWhere('pr.userId = :accessUserId')
			.getQuery();

		return query.andWhere(`EXISTS ${accessibleLink}`, {
			workflowRoleSlugs: access.workflowRoleSlugs,
			projectRoleSlugs: access.projectRoleSlugs,
			accessUserId: access.userId,
		});
	}
}
