import type {
	CreateWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestResponse,
	GetWorkflowReviewInboxSummaryResponse,
	ListWorkflowReviewInboxQueryDto,
	ListWorkflowReviewInboxResponse,
	ListWorkflowReviewRequestsQueryDto,
	UpdateWorkflowReviewRequestVersionDto,
	WorkflowReviewApprovedPublicationState,
	WorkflowReviewDecisionIneligibilityReason,
	WorkflowReviewEligibleReviewer,
	WorkflowReviewInboxItem,
	WorkflowReviewRequestDetail,
	WorkflowReviewRequestForWorkflow,
	WorkflowReviewRequestList,
	WorkflowReviewRequestSummary,
	WorkflowReviewRequestWorkflowDetail,
	WorkflowReviewVersionSnapshot,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type {
	OperationContext,
	User,
	WorkflowReviewRequest,
	WorkflowReviewRequestWorkflow,
} from '@n8n/db';
import {
	SharedWorkflowRepository,
	TransactionRunner,
	WorkflowHistoryRepository,
	WorkflowPublishedVersionRepository,
	WorkflowPublishHistoryRepository,
	WorkflowRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import { CollaborationService } from '@/collaboration/collaboration.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { WorkflowService } from '@/workflows/workflow.service';

import {
	REVIEW_AUTHORING_SCOPES,
	toEligibleReviewer,
	WorkflowReviewAccessService,
} from './workflow-review-access.service';
import { WorkflowReviewFeatureService } from './workflow-review-feature.service';
import { decodeInboxCursor, encodeInboxCursor } from './workflow-review-inbox-cursor';

const REVIEW_NOT_FOUND = 'Workflow review request not found';

@Service()
export class WorkflowReviewService {
	constructor(
		private readonly logger: Logger,
		private readonly featureService: WorkflowReviewFeatureService,
		private readonly accessService: WorkflowReviewAccessService,
		private readonly requestRepository: WorkflowReviewRequestRepository,
		private readonly linkRepository: WorkflowReviewRequestWorkflowRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
		private readonly publishHistoryRepository: WorkflowPublishHistoryRepository,
		private readonly publishedVersionRepository: WorkflowPublishedVersionRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly transactionRunner: TransactionRunner,
		private readonly collaborationService: CollaborationService,
		private readonly workflowService: WorkflowService,
	) {}

	// ---- reads ----

	async listForWorkflow(
		user: User,
		query: ListWorkflowReviewRequestsQueryDto,
	): Promise<WorkflowReviewRequestList> {
		await this.featureService.assertEnabled();
		await this.assertWorkflowReadable(query.workflowId, user);

		const { count, data } = await this.requestRepository.listForWorkflow(
			{
				workflowId: query.workflowId,
				state: query.state,
				take: query.take,
				skip: query.skip,
			},
			{},
		);

		const publicationStates = await this.resolvePublicationStates(query.workflowId, data);

		return {
			count,
			data: data.map((request) =>
				this.toWorkflowScopedItem(request, query.workflowId, publicationStates),
			),
		};
	}

	async getInboxSummary(user: User): Promise<GetWorkflowReviewInboxSummaryResponse> {
		await this.featureService.assertEnabled();
		const access = await this.accessService.resolveReadAccessFilter(user);
		return await this.requestRepository.countInboxByState(access, {});
	}

	async listInbox(
		user: User,
		query: ListWorkflowReviewInboxQueryDto,
	): Promise<ListWorkflowReviewInboxResponse> {
		await this.featureService.assertEnabled();
		const access = await this.accessService.resolveReadAccessFilter(user);

		const rows = await this.requestRepository.listInboxPage(
			{
				access,
				// An omitted state means the open inbox, which is what the sidebar opens on.
				state: query.state ?? 'open',
				limit: query.limit,
				cursor: query.cursor ? decodeInboxCursor(query.cursor) : undefined,
			},
			{},
		);

		// One row over the limit was fetched purely to answer `hasMore`.
		const hasMore = rows.length > query.limit;
		const page = hasMore ? rows.slice(0, query.limit) : rows;
		const last = page.at(-1);

		const workflowNames = await this.resolveWorkflowNames(page);

		return {
			data: page.map((request) => this.toInboxItem(request, workflowNames)),
			nextCursor:
				hasMore && last ? encodeInboxCursor({ createdAt: last.createdAt, id: last.id }) : null,
			hasMore,
		};
	}

	async getDetail(user: User, requestId: string): Promise<WorkflowReviewRequestDetail> {
		await this.featureService.assertEnabled();

		const request = await this.loadRequest(requestId);
		const linkedWorkflowIds = request.workflows.map((link) => link.workflowId);

		const readable = await this.filterReadableWorkflowIds(linkedWorkflowIds, user);
		if (readable.length === 0) throw new NotFoundError(REVIEW_NOT_FOUND);

		const workflowNames = await this.resolveWorkflowNames([request]);
		const workflows = await Promise.all(
			request.workflows.map(async (link) => await this.toWorkflowDetail(link, workflowNames)),
		);

		const { canDecide, reason } = await this.resolveDecisionEligibility(user, request);

		return {
			...this.toInboxItem(request, workflowNames),
			description: request.description,
			workflows,
			viewerCanDecide: canDecide,
			viewerDecisionIneligibilityReason: reason,
		};
	}

	async listEligibleReviewers(
		user: User,
		workflowId: string,
	): Promise<{ count: number; data: WorkflowReviewEligibleReviewer[] }> {
		await this.featureService.assertEnabled();
		await this.assertWorkflowAuthorable(workflowId, user);

		// The caller is the prospective author, so they can never review it.
		const data = await this.accessService.listEligibleReviewers(workflowId, [user.id]);
		return { count: data.length, data };
	}

	// ---- writes ----

	async create(
		user: User,
		dto: CreateWorkflowReviewRequestDto,
	): Promise<WorkflowReviewRequestSummary> {
		await this.featureService.assertEnabled();

		// The DTO pins exactly one workflow; the schema allows more, so the
		// repository shape stays plural and only this entry point is narrowed.
		const [item] = dto.workflows;
		await this.assertWorkflowAuthorable(item.workflowId, user);
		await this.assertReviewersEligible(item.workflowId, dto.reviewerUserIds ?? [], [user.id]);

		const project = await this.sharedWorkflowRepository.getWorkflowOwningProject(item.workflowId);
		if (!project) throw new NotFoundError('Workflow not found');

		const request = await this.transactionRunner.run({}, async (ctx) => {
			// No partial-unique index can express "one open review per workflow"
			// portably, so uniqueness is enforced here inside the transaction. A
			// simultaneous create on another instance can still slip through; the
			// loser is closed by the next lifecycle action rather than corrupting state.
			const existing = await this.requestRepository.findOpenRequestForWorkflow(
				item.workflowId,
				ctx,
			);
			if (existing) {
				throw new ConflictError('This workflow already has an open review request');
			}

			const created = await this.requestRepository.createRequest(
				{
					projectId: project.id,
					title: dto.title,
					description: dto.description ?? null,
					createdById: user.id,
				},
				ctx,
			);

			await this.linkRepository.createWorkflowRow(
				{
					workflowReviewRequestId: created.id,
					workflowId: item.workflowId,
					workflowVersionId: item.workflowVersionId,
				},
				ctx,
			);

			await this.applyVersionMetadata(item, ctx);
			await this.requestRepository.setAuthors({ id: created.id, userIds: [user.id] }, ctx);
			await this.requestRepository.setReviewers(
				{ id: created.id, userIds: dto.reviewerUserIds ?? [] },
				ctx,
			);

			return created;
		});

		await this.broadcast([item.workflowId]);

		return this.toSummary(request, item.workflowVersionId);
	}

	async updateVersion(
		user: User,
		requestId: string,
		dto: UpdateWorkflowReviewRequestVersionDto,
	): Promise<WorkflowReviewRequestSummary> {
		await this.featureService.assertEnabled();

		const request = await this.loadRequest(requestId);
		await this.assertWorkflowAuthorable(dto.workflowId, user, REVIEW_NOT_FOUND);

		if (!request.workflows.some((link) => link.workflowId === dto.workflowId)) {
			throw new NotFoundError(REVIEW_NOT_FOUND);
		}
		if (request.state !== 'open') {
			throw new ConflictError('This review request is closed');
		}

		await this.transactionRunner.run({}, async (ctx) => {
			const repointed = await this.linkRepository.updatePinnedVersion(
				{
					workflowReviewRequestId: requestId,
					workflowId: dto.workflowId,
					workflowVersionId: dto.workflowVersionId,
				},
				ctx,
			);
			if (repointed === 0) throw new NotFoundError(REVIEW_NOT_FOUND);

			await this.applyVersionMetadata(dto, ctx);

			// A new pin answers a request for changes, so the decision returns to
			// `pending`; the conditional update also rejects a race with a closure.
			const updated = await this.requestRepository.markUpdatedIfOpen(
				{ id: requestId, actorId: user.id },
				ctx,
			);
			if (updated === 0) throw new ConflictError('This review request is closed');

			// Re-pinning makes the updater an author too: they authored the version
			// now under review and therefore may not decide it.
			const authorIds = new Set(request.authors.map((author) => author.id));
			authorIds.add(user.id);
			await this.requestRepository.setAuthors({ id: requestId, userIds: [...authorIds] }, ctx);
		});

		await this.broadcast([dto.workflowId]);

		const updated = await this.loadRequest(requestId);
		return this.toSummary(updated, dto.workflowVersionId);
	}

	async decide(
		user: User,
		requestId: string,
		dto: DecideWorkflowReviewRequestDto,
	): Promise<DecideWorkflowReviewRequestResponse> {
		await this.featureService.assertEnabled();

		const request = await this.loadRequest(requestId);
		const link = request.workflows[0];
		if (!link) throw new NotFoundError(REVIEW_NOT_FOUND);

		// Re-checked here rather than trusted from the detail response: eligibility
		// there is advisory and deliberately ignores the request lifecycle.
		const { canDecide, reason } = await this.resolveDecisionEligibility(user, request);
		if (!canDecide) {
			if (reason === null) throw new NotFoundError(REVIEW_NOT_FOUND);
			throw new ForbiddenError(
				reason === 'author'
					? 'You cannot decide on a review request you authored'
					: 'You do not have permission to decide on this review request',
			);
		}

		if (request.state !== 'open') {
			throw new ConflictError('This review request has already been decided');
		}

		const approving = dto.decision === 'approved';

		const affected = await this.transactionRunner.run(
			{},
			async (ctx) =>
				await this.requestRepository.applyDecisionIfOpen(
					{
						id: requestId,
						// Guards against a second reviewer overwriting a decision made
						// between this caller's read and their submit.
						expectedDecision: request.decision,
						decision: dto.decision,
						actorId: user.id,
						close: approving,
						approvedAt: approving ? new Date() : null,
					},
					ctx,
				),
		);

		if (affected === 0) {
			throw new ConflictError('This review request has already been decided');
		}

		const updated = await this.loadRequest(requestId);
		const summary = this.toSummary(updated, link.workflowVersionId);

		// Publication is attempted only after the approval has committed: the
		// publish guard would otherwise see this very request still open and block
		// the version it just approved.
		const autoPublish = approving ? await this.publishApprovedVersion(user, link) : undefined;

		await this.broadcast([link.workflowId]);

		return autoPublish ? { ...summary, autoPublish } : summary;
	}

	/**
	 * Closes every open review on the given workflows. Used by the lifecycle
	 * hooks: an archived, transferred or deleted workflow can no longer be
	 * reviewed, and leaving the review open would keep blocking publication.
	 */
	async closeOpenReviewsForWorkflows(workflowIds: string[], actorId: string | null): Promise<void> {
		if (workflowIds.length === 0) return;

		const closedIds = await this.transactionRunner.run(
			{},
			async (ctx) =>
				await this.requestRepository.closeOpenRequestsForWorkflows({ workflowIds, actorId }, ctx),
		);
		if (closedIds.length === 0) return;

		const affectedWorkflowIds = await this.linkRepository.findWorkflowIdsByRequestIds(
			closedIds,
			{},
		);
		await this.broadcast(affectedWorkflowIds);
	}

	/** The open review blocking publication of a workflow, if any. */
	async findBlockingReview(
		workflowId: string,
	): Promise<{ id: string; decision: 'pending' | 'changes_requested' } | null> {
		const open = await this.requestRepository.findOpenRequestForWorkflow(workflowId, {});
		if (!open || open.decision === 'approved') return null;
		return { id: open.id, decision: open.decision };
	}

	// ---- internals ----

	private async publishApprovedVersion(
		user: User,
		link: WorkflowReviewRequestWorkflow,
	): Promise<DecideWorkflowReviewRequestResponse['autoPublish']> {
		if (!link.workflowVersionId) {
			return { status: 'failed', message: 'The approved version is no longer available' };
		}

		try {
			// The pinned version is published, never the current working copy — the
			// working copy may have moved on since the review was opened.
			await this.workflowService.activateWorkflow(user, link.workflowId, {
				versionId: link.workflowVersionId,
			});
			return { status: 'published' };
		} catch (error) {
			// A failed publication must not undo the approval: the workflow can be
			// published later through the ordinary publish flow, which is the retry.
			const message = ensureError(error).message;
			this.logger.warn('Auto-publication after review approval failed', {
				workflowId: link.workflowId,
				versionId: link.workflowVersionId,
				message,
			});
			return { status: 'failed', message };
		}
	}

	private async loadRequest(requestId: string): Promise<WorkflowReviewRequest> {
		const request = await this.requestRepository.findRequestWithRelations(requestId, {});
		if (!request) throw new NotFoundError(REVIEW_NOT_FOUND);
		return request;
	}

	private async assertWorkflowReadable(workflowId: string, user: User): Promise<void> {
		if (!(await this.accessService.canReadWorkflow(workflowId, user))) {
			throw new NotFoundError('Workflow not found');
		}
	}

	private async assertWorkflowAuthorable(
		workflowId: string,
		user: User,
		message = 'Workflow not found',
	): Promise<void> {
		const workflow = await this.accessService.findWorkflowWithScopes(
			workflowId,
			user,
			REVIEW_AUTHORING_SCOPES,
		);
		if (!workflow) throw new NotFoundError(message);
	}

	private async assertReviewersEligible(
		workflowId: string,
		reviewerUserIds: string[],
		excludeUserIds: string[],
	): Promise<void> {
		if (reviewerUserIds.length === 0) return;

		const eligible = await this.accessService.listEligibleReviewers(workflowId, excludeUserIds);
		const eligibleIds = new Set(eligible.map((reviewer) => reviewer.id));
		const invalid = reviewerUserIds.filter((id) => !eligibleIds.has(id));
		if (invalid.length > 0) {
			throw new BadRequestError('One or more selected reviewers cannot review this workflow');
		}
	}

	private async applyVersionMetadata(
		item: {
			workflowId: string;
			workflowVersionId: string;
			workflowVersionName: string;
			workflowVersionDescription?: string;
		},
		ctx: OperationContext,
	): Promise<void> {
		const description = item.workflowVersionDescription;
		await this.workflowHistoryRepository.updateVersionMetadata(
			{
				workflowId: item.workflowId,
				versionId: item.workflowVersionId,
				name: item.workflowVersionName,
				// An empty or whitespace-only description clears the stored one.
				...(description !== undefined
					? { description: description.trim().length > 0 ? description : null }
					: {}),
			},
			ctx,
		);
	}

	private async filterReadableWorkflowIds(workflowIds: string[], user: User): Promise<string[]> {
		const results = await Promise.all(
			workflowIds.map(
				async (id) =>
					await this.accessService.canReadWorkflow(id, user).then((ok) => (ok ? id : null)),
			),
		);
		return results.filter((id): id is string => id !== null);
	}

	/**
	 * Who may decide, and why not. Kept in one place so the advisory detail flag
	 * and the enforcing decision endpoint can never disagree.
	 */
	private async resolveDecisionEligibility(
		user: User,
		request: WorkflowReviewRequest,
	): Promise<{
		canDecide: boolean;
		reason: WorkflowReviewDecisionIneligibilityReason | null;
	}> {
		const link = request.workflows[0];
		if (!link) return { canDecide: false, reason: null };

		if (!(await this.accessService.canReadWorkflow(link.workflowId, user))) {
			// Not visible at all: no reason is exposed, and callers turn this into a 404.
			return { canDecide: false, reason: null };
		}

		const authorIds = new Set(request.authors.map((author) => author.id));
		if (request.createdById) authorIds.add(request.createdById);
		if (authorIds.has(user.id)) {
			return { canDecide: false, reason: 'author' };
		}

		if (!(await this.accessService.canPublishWorkflow(link.workflowId, user))) {
			return { canDecide: false, reason: 'missing_publish_permission' };
		}

		return { canDecide: true, reason: null };
	}

	private async resolvePublicationStates(
		workflowId: string,
		requests: WorkflowReviewRequest[],
	): Promise<Map<string, WorkflowReviewApprovedPublicationState>> {
		const versionIds = requests
			.filter((request) => request.decision === 'approved')
			.map((request) => this.pinnedVersionId(request, workflowId))
			.filter((versionId): versionId is string => versionId !== null);

		if (versionIds.length === 0) return new Map();

		return await this.publishHistoryRepository.getVersionPublicationStates(workflowId, versionIds);
	}

	private pinnedVersionId(request: WorkflowReviewRequest, workflowId?: string): string | null {
		const link = workflowId
			? request.workflows?.find((candidate) => candidate.workflowId === workflowId)
			: request.workflows?.[0];
		return link?.workflowVersionId ?? null;
	}

	private toSummary(
		request: WorkflowReviewRequest,
		workflowVersionId?: string | null,
	): WorkflowReviewRequestSummary {
		return {
			id: request.id,
			state: request.state,
			decision: request.decision,
			workflowVersionId: workflowVersionId ?? this.pinnedVersionId(request),
			createdAt: request.createdAt.toISOString(),
			updatedAt: request.updatedAt.toISOString(),
		};
	}

	private toWorkflowScopedItem(
		request: WorkflowReviewRequest,
		workflowId: string,
		publicationStates: Map<string, WorkflowReviewApprovedPublicationState>,
	): WorkflowReviewRequestForWorkflow {
		const versionId = this.pinnedVersionId(request, workflowId);
		// The decision actor is whoever closed it, or — while still open after a
		// change request — whoever last touched it.
		const decisionActor =
			request.decision === 'pending' ? null : (request.closedBy ?? request.updatedBy ?? null);

		return {
			...this.toSummary(request, versionId),
			decisionBy: decisionActor ? toEligibleReviewer(decisionActor) : null,
			approvedVersionPublicationState:
				request.decision === 'approved'
					? // A null pin has no history row to derive from, so it cannot be
						// resolved rather than being reported as unpublished.
						(publicationStates.get(versionId ?? '') ?? 'unknown')
					: null,
		};
	}

	private toInboxItem(
		request: WorkflowReviewRequest,
		workflowNames: Map<string, string>,
	): WorkflowReviewInboxItem {
		const link = request.workflows?.[0];

		return {
			...this.toSummary(request, link?.workflowVersionId ?? null),
			projectId: request.projectId,
			title: request.title,
			workflowName: link ? (workflowNames.get(link.workflowId) ?? null) : null,
			requester: request.createdBy ? toEligibleReviewer(request.createdBy) : null,
			reviewers: (request.reviewers ?? []).map(toEligibleReviewer),
		};
	}

	private async toWorkflowDetail(
		link: WorkflowReviewRequestWorkflow,
		workflowNames: Map<string, string>,
	): Promise<WorkflowReviewRequestWorkflowDetail> {
		const [pinnedVersion, baselineVersion] = await Promise.all([
			this.loadVersionSnapshot(link.workflowId, link.workflowVersionId),
			this.loadBaselineSnapshot(link.workflowId),
		]);

		return {
			workflowId: link.workflowId,
			workflowName: workflowNames.get(link.workflowId) ?? '',
			workflowVersionId: link.workflowVersionId,
			pinnedVersion,
			baselineVersion,
		};
	}

	/** The currently published version is the diff baseline; never published → null. */
	private async loadBaselineSnapshot(
		workflowId: string,
	): Promise<WorkflowReviewVersionSnapshot | null> {
		const publishedVersionId =
			await this.publishedVersionRepository.getPublishedVersionId(workflowId);
		return await this.loadVersionSnapshot(workflowId, publishedVersionId);
	}

	private async loadVersionSnapshot(
		workflowId: string,
		versionId: string | null,
	): Promise<WorkflowReviewVersionSnapshot | null> {
		if (!versionId) return null;

		const version = await this.workflowHistoryRepository.findOne({
			where: { workflowId, versionId },
		});
		if (!version) return null;

		return {
			versionId: version.versionId,
			name: version.name,
			nodes: version.nodes,
			connections: version.connections,
			nodeGroups: version.nodeGroups ?? [],
			createdAt: version.createdAt.toISOString(),
		};
	}

	private async resolveWorkflowNames(
		requests: WorkflowReviewRequest[],
	): Promise<Map<string, string>> {
		const workflowIds = [
			...new Set(requests.flatMap((request) => (request.workflows ?? []).map((l) => l.workflowId))),
		];
		if (workflowIds.length === 0) return new Map();

		const workflows = await this.workflowRepository.findByIds(workflowIds, {
			fields: ['id', 'name'],
		});
		return new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
	}

	/** Invalidation-only fan-out; clients refetch the authoritative state. */
	private async broadcast(workflowIds: string[]): Promise<void> {
		for (const workflowId of new Set(workflowIds)) {
			try {
				await this.collaborationService.broadcastWorkflowReviewStateChanged(workflowId);
			} catch (error) {
				// Best-effort delivery: a push failure must not fail the write that
				// already committed. Viewers heal on focus/reconnect refetch.
				this.logger.warn('Failed to broadcast workflow review state change', {
					workflowId,
					message: ensureError(error).message,
				});
			}
		}
	}
}
