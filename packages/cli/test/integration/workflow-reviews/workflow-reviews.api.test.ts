import {
	createTeamProject,
	createWorkflow,
	createWorkflowHistory,
	linkUserToProject,
	testDb,
} from '@n8n/backend-test-utils';
import type { Project, User, WorkflowEntity } from '@n8n/db';
import {
	SharedWorkflowRepository,
	WorkflowHistoryRepository,
	WorkflowPublishedVersionRepository,
	WorkflowRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { v4 as uuid } from 'uuid';

import { WORKFLOW_REVIEWS_ENV_FEATURE_FLAG } from '@/constants/workflow-reviews';
import { WorkflowReviewAccessService } from '@/modules/workflow-reviews/workflow-review-access.service';
import { WorkflowReviewService } from '@/modules/workflow-reviews/workflow-review.service';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import { EnterpriseWorkflowService } from '@/workflows/workflow-collaboration.service';
import { WorkflowPublishGuardProxy } from '@/workflows/workflow-publish-guard-proxy.service';
import { WorkflowService } from '@/workflows/workflow.service';

import { createMember, createOwner } from '../shared/db/users';
import type { SuperAgentTest } from '../shared/types';
import { setupTestServer } from '../shared/utils';

/**
 * Endpoint contract for the workflow-reviews module. Derived from the surviving
 * DTOs, the frontend REST client and the migration — there was no inherited
 * backend spec, so these assertions are the spec.
 */
describe('workflow reviews API', () => {
	const testServer = setupTestServer({
		endpointGroups: ['workflow-reviews'],
		modules: ['workflow-reviews'],
	});

	let author: User;
	let reviewer: User;
	let viewer: User;
	let outsider: User;
	let owner: User;

	let authorAgent: SuperAgentTest;
	let reviewerAgent: SuperAgentTest;
	let viewerAgent: SuperAgentTest;
	let outsiderAgent: SuperAgentTest;

	let project: Project;
	let workflow: WorkflowEntity;
	let pinnedVersionId: string;

	beforeAll(async () => {
		process.env[WORKFLOW_REVIEWS_ENV_FEATURE_FLAG] = 'true';

		owner = await createOwner();
		author = await createMember();
		reviewer = await createMember();
		viewer = await createMember();
		outsider = await createMember();

		authorAgent = testServer.authAgentFor(author);
		reviewerAgent = testServer.authAgentFor(reviewer);
		viewerAgent = testServer.authAgentFor(viewer);
		outsiderAgent = testServer.authAgentFor(outsider);
	});

	afterAll(() => {
		delete process.env[WORKFLOW_REVIEWS_ENV_FEATURE_FLAG];
	});

	beforeEach(async () => {
		await testDb.truncate([
			'WorkflowReviewRequestWorkflow',
			'WorkflowReviewRequest',
			'WorkflowPublishedVersion',
			'WorkflowPublishHistory',
			'WorkflowHistory',
			'SharedWorkflow',
			'WorkflowEntity',
			'Settings',
		]);

		testServer.license.enable('feat:workflowReviews');
		await Container.get(WorkflowReviewPolicyService).set(true);

		project = await createTeamProject(`reviews-${uuid()}`);
		await linkUserToProject(author, project, 'project:admin');
		await linkUserToProject(reviewer, project, 'project:admin');
		await linkUserToProject(viewer, project, 'project:viewer');

		pinnedVersionId = uuid();
		workflow = await createWorkflow(
			{ name: 'Reviewed workflow', versionId: pinnedVersionId },
			project,
		);
		await createWorkflowHistory(workflow);
	});

	// ---- helpers ----

	const createPayload = (overrides: Record<string, unknown> = {}) => ({
		title: 'Please review',
		description: 'A description',
		workflows: [
			{
				workflowId: workflow.id,
				workflowVersionId: pinnedVersionId,
				workflowVersionName: 'v1',
			},
		],
		...overrides,
	});

	const openReview = async (agent: SuperAgentTest = authorAgent) => {
		const response = await agent
			.post('/workflow-review-requests')
			.send(createPayload())
			.expect(200);
		return response.body.data as { id: string; state: string; decision: string };
	};

	const addHistoryVersion = async (versionId: string, published = false) => {
		await createWorkflowHistory(
			{ ...workflow, versionId },
			undefined,
			published ? { event: 'activated' } : undefined,
		);
		return versionId;
	};

	// ---- POST /workflow-review-requests ----

	describe('POST /workflow-review-requests', () => {
		it('creates an open, pending review pinned to the given version', async () => {
			const response = await authorAgent
				.post('/workflow-review-requests')
				.send(createPayload())
				.expect(200);

			expect(response.body.data).toEqual({
				id: expect.any(String),
				state: 'open',
				decision: 'pending',
				workflowVersionId: pinnedVersionId,
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
			});

			const links = await Container.get(WorkflowReviewRequestWorkflowRepository).findByRequestId(
				response.body.data.id,
				{},
			);
			expect(links).toHaveLength(1);
			expect(links[0].workflowId).toBe(workflow.id);
			expect(links[0].workflowVersionId).toBe(pinnedVersionId);
		});

		it('names the pinned workflow-history version from the payload', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send(
					createPayload({
						workflows: [
							{
								workflowId: workflow.id,
								workflowVersionId: pinnedVersionId,
								workflowVersionName: 'Release candidate',
								workflowVersionDescription: 'Ships the new webhook',
							},
						],
					}),
				)
				.expect(200);

			const version = await Container.get(WorkflowHistoryRepository).findOne({
				where: { workflowId: workflow.id, versionId: pinnedVersionId },
			});
			expect(version?.name).toBe('Release candidate');
			expect(version?.description).toBe('Ships the new webhook');
		});

		it('clears the version description when an empty one is sent', async () => {
			await Container.get(WorkflowHistoryRepository).updateVersionMetadata(
				{
					workflowId: workflow.id,
					versionId: pinnedVersionId,
					name: 'old',
					description: 'old description',
				},
				{},
			);

			await authorAgent
				.post('/workflow-review-requests')
				.send(
					createPayload({
						workflows: [
							{
								workflowId: workflow.id,
								workflowVersionId: pinnedVersionId,
								workflowVersionName: 'v1',
								workflowVersionDescription: '   ',
							},
						],
					}),
				)
				.expect(200);

			const version = await Container.get(WorkflowHistoryRepository).findOne({
				where: { workflowId: workflow.id, versionId: pinnedVersionId },
			});
			expect(version?.description).toBeNull();
		});

		it('rejects a second open review for the same workflow with 409', async () => {
			await openReview();
			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(409);
		});

		it('rejects a version that belongs to another workflow with 404', async () => {
			const foreignVersionId = uuid();
			const other = await createWorkflow({ name: 'Other', versionId: foreignVersionId }, project);
			await createWorkflowHistory(other);

			await authorAgent
				.post('/workflow-review-requests')
				.send(
					createPayload({
						workflows: [
							{
								workflowId: workflow.id,
								workflowVersionId: foreignVersionId,
								workflowVersionName: 'v1',
							},
						],
					}),
				)
				.expect(404);

			const { count } = await Container.get(WorkflowReviewRequestRepository).listForWorkflow(
				{ workflowId: workflow.id },
				{},
			);
			expect(count).toBe(0);
		});

		it('rejects a version that does not exist at all with 404', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send(
					createPayload({
						workflows: [
							{ workflowId: workflow.id, workflowVersionId: uuid(), workflowVersionName: 'v1' },
						],
					}),
				)
				.expect(404);
		});

		it('rejects a concurrent second create at the database boundary with 409', async () => {
			await openReview();

			// Stands in for the interleaving the in-transaction pre-check cannot see:
			// the check observes no open review while another create already committed
			// one. The open sentinel's unique constraint is what has to reject it.
			const precheck = vi
				.spyOn(Container.get(WorkflowReviewRequestRepository), 'findOpenRequestForWorkflow')
				.mockResolvedValue(null);

			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(409);

			precheck.mockRestore();

			const { count } = await Container.get(WorkflowReviewRequestRepository).listForWorkflow(
				{ workflowId: workflow.id },
				{},
			);
			expect(count).toBe(1);
		});

		it('rejects a second open sentinel for the same workflow at the repository', async () => {
			const review = await openReview();
			const other = await Container.get(WorkflowReviewRequestRepository).createRequest(
				{ projectId: project.id, title: 'Second', createdById: author.id },
				{},
			);

			const result = await Container.get(WorkflowReviewRequestWorkflowRepository).createWorkflowRow(
				{
					workflowReviewRequestId: other.id,
					workflowId: workflow.id,
					workflowVersionId: pinnedVersionId,
					open: true,
				},
				{},
			);

			expect(result.status).toBe('open-review-exists');
			const links = await Container.get(WorkflowReviewRequestWorkflowRepository).findByRequestId(
				review.id,
				{},
			);
			expect(links[0].openWorkflowId).toBe(workflow.id);
		});

		it('allows a new review once the previous one was approved', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			// The sentinel has to be released on closure, or the workflow could never
			// be reviewed again.
			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(200);
		});

		it('rejects a caller without publish rights on the workflow with 404', async () => {
			await viewerAgent.post('/workflow-review-requests').send(createPayload()).expect(404);
		});

		it('rejects a caller with no access to the workflow with 404', async () => {
			await outsiderAgent.post('/workflow-review-requests').send(createPayload()).expect(404);
		});

		it('rejects a reviewer who cannot publish the workflow with 400', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send(createPayload({ reviewerUserIds: [viewer.id] }))
				.expect(400);
		});

		it('accepts an eligible reviewer', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send(createPayload({ reviewerUserIds: [reviewer.id] }))
				.expect(200);
		});

		it('rejects an invalid payload with 400', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send({ title: '', workflows: [] })
				.expect(400);
		});

		it('returns 403 when the policy is disabled', async () => {
			await Container.get(WorkflowReviewPolicyService).set(false);
			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(403);
		});

		it('returns 403 when the feature is unlicensed', async () => {
			testServer.license.disable('feat:workflowReviews');
			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(403);
		});
	});

	// ---- GET /workflow-review-requests ----

	describe('GET /workflow-review-requests', () => {
		it('returns the workflow-scoped list newest-first', async () => {
			const first = await openReview();
			// Close it so a second one may be opened.
			await reviewerAgent
				.post(`/workflow-review-requests/${first.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);
			const second = await openReview();

			const response = await authorAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id, take: 1 })
				.expect(200);

			expect(response.body.data.count).toBe(2);
			expect(response.body.data.data).toHaveLength(1);
			// `take: 1` is how the canvas resolves "the latest review".
			expect(response.body.data.data[0].id).toBe(second.id);
		});

		it('filters by state', async () => {
			const first = await openReview();
			await reviewerAgent
				.post(`/workflow-review-requests/${first.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);
			await openReview();

			const closed = await authorAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id, state: 'closed' })
				.expect(200);
			expect(closed.body.data.count).toBe(1);
			expect(closed.body.data.data[0].id).toBe(first.id);
		});

		it('leaves approvedVersionPublicationState null while pending', async () => {
			await openReview();

			const response = await authorAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id })
				.expect(200);

			expect(response.body.data.data[0].approvedVersionPublicationState).toBeNull();
			expect(response.body.data.data[0].decisionBy).toBeNull();
		});

		it('derives the publication state and decision author once approved', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			const response = await authorAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id })
				.expect(200);

			const item = response.body.data.data[0];
			expect(item.decision).toBe('approved');
			expect(item.approvedVersionPublicationState).toBe('not_published');
			expect(item.decisionBy).toEqual({
				id: reviewer.id,
				email: reviewer.email,
				firstName: reviewer.firstName ?? null,
				lastName: reviewer.lastName ?? null,
			});
		});

		it('reports unknown when the approved pin was pruned', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			// Simulate the history row being pruned: the FK nulls the pin.
			await Container.get(WorkflowReviewRequestWorkflowRepository).updatePinnedVersion(
				{
					workflowReviewRequestId: review.id,
					workflowId: workflow.id,
					workflowVersionId: null,
				},
				{},
			);

			const response = await authorAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id })
				.expect(200);

			expect(response.body.data.data[0].workflowVersionId).toBeNull();
			expect(response.body.data.data[0].approvedVersionPublicationState).toBe('unknown');
		});

		it('rejects a caller without read access with 404', async () => {
			await openReview();
			await outsiderAgent
				.get('/workflow-review-requests')
				.query({ workflowId: workflow.id })
				.expect(404);
		});

		it('rejects a missing workflowId with 400', async () => {
			await authorAgent.get('/workflow-review-requests').expect(400);
		});
	});

	// ---- GET /workflow-review-requests/eligible-reviewers ----

	describe('GET /workflow-review-requests/eligible-reviewers', () => {
		it('lists users who can publish, excluding the caller', async () => {
			const response = await authorAgent
				.get('/workflow-review-requests/eligible-reviewers')
				.query({ workflowId: workflow.id })
				.expect(200);

			const ids = response.body.data.data.map((r: { id: string }) => r.id);
			expect(ids).toContain(reviewer.id);
			expect(ids).not.toContain(author.id);
			expect(ids).not.toContain(viewer.id);
			expect(ids).not.toContain(outsider.id);
			expect(response.body.data.count).toBe(ids.length);
		});

		it('exposes only the four allowed user fields', async () => {
			const response = await authorAgent
				.get('/workflow-review-requests/eligible-reviewers')
				.query({ workflowId: workflow.id })
				.expect(200);

			for (const entry of response.body.data.data) {
				expect(Object.keys(entry).sort()).toEqual(['email', 'firstName', 'id', 'lastName']);
			}
		});

		it('rejects a caller who cannot author a review on the workflow with 404', async () => {
			await viewerAgent
				.get('/workflow-review-requests/eligible-reviewers')
				.query({ workflowId: workflow.id })
				.expect(404);
		});
	});

	// ---- POST /:id/update-version ----

	describe('POST /workflow-review-requests/:id/update-version', () => {
		it('repoints the pin and keeps the review open', async () => {
			const review = await openReview();
			const newVersionId = await addHistoryVersion(uuid());

			const response = await authorAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: newVersionId,
					workflowVersionName: 'v2',
				})
				.expect(200);

			expect(response.body.data.state).toBe('open');
			expect(response.body.data.workflowVersionId).toBe(newVersionId);
		});

		it('resets a changes_requested review back to pending', async () => {
			const review = await openReview();
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'changes_requested', expectedVersionId: pinnedVersionId })
				.expect(200);

			const newVersionId = await addHistoryVersion(uuid());
			const response = await authorAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: newVersionId,
					workflowVersionName: 'v2',
				})
				.expect(200);

			expect(response.body.data.decision).toBe('pending');
			expect(response.body.data.state).toBe('open');
		});

		it('rejects updating a closed review with 409', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			// The version is created before the payload literal: an `await` inside it
			// lets the request start before `.send()` runs, so the body arrives empty.
			const newVersionId = await addHistoryVersion(uuid());

			await authorAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: newVersionId,
					workflowVersionName: 'v2',
				})
				.expect(409);
		});

		it('rejects repinning to a version of another workflow with 404', async () => {
			const review = await openReview();
			const foreignVersionId = uuid();
			const other = await createWorkflow({ name: 'Other', versionId: foreignVersionId }, project);
			await createWorkflowHistory(other);

			await authorAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: foreignVersionId,
					workflowVersionName: 'v2',
				})
				.expect(404);

			const links = await Container.get(WorkflowReviewRequestWorkflowRepository).findByRequestId(
				review.id,
				{},
			);
			expect(links[0].workflowVersionId).toBe(pinnedVersionId);
		});

		it('rejects a caller without publish rights with 404', async () => {
			const review = await openReview();
			await viewerAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: pinnedVersionId,
					workflowVersionName: 'v2',
				})
				.expect(404);
		});

		it('rejects an unknown review with 404', async () => {
			await authorAgent
				.post(`/workflow-review-requests/${uuid()}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: pinnedVersionId,
					workflowVersionName: 'v2',
				})
				.expect(404);
		});
	});

	// ---- POST /:id/decision ----

	describe('POST /workflow-review-requests/:id/decision', () => {
		it('records changes_requested and leaves the review open', async () => {
			const review = await openReview();

			const response = await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'changes_requested', expectedVersionId: pinnedVersionId })
				.expect(200);

			expect(response.body.data.decision).toBe('changes_requested');
			expect(response.body.data.state).toBe('open');
			expect(response.body.data.autoPublish).toBeUndefined();
		});

		it('approves, closes the review and reports a successful publication', async () => {
			const review = await openReview();
			const activateSpy = vi
				.spyOn(Container.get(WorkflowService), 'activateWorkflow')
				.mockResolvedValue(workflow);

			const response = await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			expect(response.body.data.decision).toBe('approved');
			expect(response.body.data.state).toBe('closed');
			expect(response.body.data.autoPublish).toEqual({ status: 'published' });
			// The pinned version is published, not the current working copy.
			expect(activateSpy).toHaveBeenCalledWith(
				expect.objectContaining({ id: reviewer.id }),
				workflow.id,
				{ versionId: pinnedVersionId },
			);
		});

		it('keeps the approval when publication fails', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockRejectedValue(
				new Error('Cannot activate an archived workflow.'),
			);

			const response = await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			expect(response.body.data.decision).toBe('approved');
			expect(response.body.data.state).toBe('closed');
			expect(response.body.data.autoPublish).toEqual({
				status: 'failed',
				message: 'Cannot activate an archived workflow.',
			});

			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.decision).toBe('approved');
			expect(stored?.state).toBe('closed');
		});

		it('accepts a decision that names the version the reviewer inspected', async () => {
			const review = await openReview();
			const activateSpy = vi
				.spyOn(Container.get(WorkflowService), 'activateWorkflow')
				.mockResolvedValue(workflow);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			expect(activateSpy).toHaveBeenCalledWith(expect.anything(), workflow.id, {
				versionId: pinnedVersionId,
			});
		});

		it('rejects a decision naming a version the request no longer pins with 409', async () => {
			const review = await openReview();
			const newVersionId = await addHistoryVersion(uuid());
			await authorAgent
				.post(`/workflow-review-requests/${review.id}/update-version`)
				.send({
					workflowId: workflow.id,
					workflowVersionId: newVersionId,
					workflowVersionName: 'v2',
				})
				.expect(200);

			const activateSpy = vi
				.spyOn(Container.get(WorkflowService), 'activateWorkflow')
				.mockResolvedValue(workflow);

			// The reviewer inspected v1; the author has since pinned v2. Approving
			// would publish a version nobody reviewed.
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(409);

			expect(activateSpy).not.toHaveBeenCalled();
			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('open');
			expect(stored?.decision).toBe('pending');
		});

		it('rejects a decision whose pin moved after the request was loaded with 409', async () => {
			const review = await openReview();
			const activateSpy = vi
				.spyOn(Container.get(WorkflowService), 'activateWorkflow')
				.mockResolvedValue(workflow);

			const linkRepository = Container.get(WorkflowReviewRequestWorkflowRepository);
			const [link] = await linkRepository.findByRequestId(review.id, {});

			// Reports a pin the row no longer carries, which is what the deciding
			// transaction sees when a re-pin commits under it.
			const stalePin = vi
				.spyOn(linkRepository, 'findByRequestId')
				.mockResolvedValue([{ ...link, workflowVersionId: uuid() }]);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(409);

			stalePin.mockRestore();
			expect(activateSpy).not.toHaveBeenCalled();
			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('open');
		});

		it('publishes the pin the deciding transaction read, not one loaded earlier', async () => {
			const review = await openReview();
			const newVersionId = await addHistoryVersion(uuid());
			const activateSpy = vi
				.spyOn(Container.get(WorkflowService), 'activateWorkflow')
				.mockResolvedValue(workflow);

			// Re-pins after `decide` loaded the request but before its transaction
			// runs — the interleaving that let a stale link be published.
			const accessService = Container.get(WorkflowReviewAccessService);
			const canPublish = vi
				.spyOn(accessService, 'canPublishWorkflow')
				.mockImplementation(async () => {
					canPublish.mockRestore();
					await authorAgent
						.post(`/workflow-review-requests/${review.id}/update-version`)
						.send({
							workflowId: workflow.id,
							workflowVersionId: newVersionId,
							workflowVersionName: 'v2',
						})
						.expect(200);
					return true;
				});

			// The reviewer names the version the transaction will see, so the decision
			// is valid; what is under test is that the publish uses the pin read inside
			// the deciding transaction, not the one `decide` loaded before the re-pin.
			// (Naming the superseded version is the 409 case above.)
			const response = await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: newVersionId })
				.expect(200);

			expect(activateSpy).toHaveBeenCalledWith(expect.anything(), workflow.id, {
				versionId: newVersionId,
			});
			expect(response.body.data.workflowVersionId).toBe(newVersionId);
		});

		it('rejects a decision by an author with 403', async () => {
			const review = await openReview();
			await authorAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(403);
		});

		it('rejects a decision by someone without publish rights with 403', async () => {
			const review = await openReview();
			await viewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(403);
		});

		it('rejects a decision by someone with no access with 404', async () => {
			const review = await openReview();
			await outsiderAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(404);
		});

		it('rejects a second, stale decision with 409', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(409);
		});

		it('refuses to decide a request spanning several workflows', async () => {
			// The DTO admits exactly one workflow, but the schema permits more. If a
			// second link ever appears, the decision path must not silently authorize
			// against one workflow while publishing another's pin.
			const review = await openReview();
			const otherVersionId = uuid();
			const other = await createWorkflow({ name: 'Other', versionId: otherVersionId }, project);
			await createWorkflowHistory(other);
			await Container.get(WorkflowReviewRequestWorkflowRepository).createWorkflowRow(
				{
					workflowReviewRequestId: review.id,
					workflowId: other.id,
					workflowVersionId: otherVersionId,
					open: true,
				},
				{},
			);

			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(500);
		});

		it('rejects `pending` as an input decision with 400', async () => {
			const review = await openReview();
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'pending' })
				.expect(400);
		});
	});

	// ---- GET /summary and /inbox ----

	describe('GET /workflow-review-requests/summary', () => {
		it('counts open and closed reviews the caller can see', async () => {
			const first = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${first.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);
			await openReview();

			const response = await reviewerAgent.get('/workflow-review-requests/summary').expect(200);
			expect(response.body.data).toEqual({ open: 1, closed: 1 });
		});

		it('hides reviews the caller cannot read', async () => {
			await openReview();
			const response = await outsiderAgent.get('/workflow-review-requests/summary').expect(200);
			expect(response.body.data).toEqual({ open: 0, closed: 0 });
		});

		it('is not swallowed by the /:id route', async () => {
			// A 200 here proves the static path is matched before `/:workflowReviewRequestId`,
			// which would answer 404 for the literal id "summary".
			await reviewerAgent.get('/workflow-review-requests/summary').expect(200);
		});
	});

	describe('GET /workflow-review-requests/inbox', () => {
		it('returns open reviews by default with requester and reviewers', async () => {
			await authorAgent
				.post('/workflow-review-requests')
				.send(createPayload({ reviewerUserIds: [reviewer.id] }))
				.expect(200);

			const response = await reviewerAgent.get('/workflow-review-requests/inbox').expect(200);

			expect(response.body.data.data).toHaveLength(1);
			const item = response.body.data.data[0];
			expect(item.state).toBe('open');
			expect(item.title).toBe('Please review');
			expect(item.projectId).toBe(project.id);
			expect(item.workflowName).toBe('Reviewed workflow');
			expect(item.requester.id).toBe(author.id);
			expect(item.reviewers.map((r: { id: string }) => r.id)).toEqual([reviewer.id]);
			expect(response.body.data.hasMore).toBe(false);
			expect(response.body.data.nextCursor).toBeNull();
		});

		it('paginates newest-first with an opaque cursor', async () => {
			const created: string[] = [];
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);

			// Three reviews on three workflows, so all can be open at once.
			for (let i = 0; i < 3; i++) {
				const versionId = uuid();
				const extra = await createWorkflow({ name: `wf-${i}`, versionId }, project);
				await createWorkflowHistory(extra);
				const response = await authorAgent
					.post('/workflow-review-requests')
					.send({
						title: `Review ${i}`,
						workflows: [
							{ workflowId: extra.id, workflowVersionId: versionId, workflowVersionName: 'v1' },
						],
					})
					.expect(200);
				created.push(response.body.data.id);
			}

			const page1 = await reviewerAgent
				.get('/workflow-review-requests/inbox')
				.query({ limit: 2 })
				.expect(200);
			expect(page1.body.data.data).toHaveLength(2);
			expect(page1.body.data.hasMore).toBe(true);
			expect(typeof page1.body.data.nextCursor).toBe('string');

			const page2 = await reviewerAgent
				.get('/workflow-review-requests/inbox')
				.query({ limit: 2, cursor: page1.body.data.nextCursor })
				.expect(200);
			expect(page2.body.data.hasMore).toBe(false);

			const seen = [...page1.body.data.data, ...page2.body.data.data].map(
				(item: { id: string }) => item.id,
			);
			// Every created review appears exactly once across the pages.
			expect(new Set(seen).size).toBe(seen.length);
			for (const id of created) expect(seen).toContain(id);
		});

		it('filters by state', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			const open = await reviewerAgent
				.get('/workflow-review-requests/inbox')
				.query({ state: 'open' })
				.expect(200);
			expect(open.body.data.data).toHaveLength(0);

			const closed = await reviewerAgent
				.get('/workflow-review-requests/inbox')
				.query({ state: 'closed' })
				.expect(200);
			expect(closed.body.data.data).toHaveLength(1);
		});

		it('hides reviews the caller cannot read', async () => {
			await openReview();
			const response = await outsiderAgent.get('/workflow-review-requests/inbox').expect(200);
			expect(response.body.data.data).toHaveLength(0);
		});

		it("includes reviews on a workflow in the caller's personal project", async () => {
			// Personal-space workflows are the common case; the inbox filter is the one
			// place that does not go through WorkflowFinderService, so it is pinned here.
			const personalVersionId = uuid();
			const personalWorkflow = await createWorkflow(
				{ name: 'Personal workflow', versionId: personalVersionId },
				author,
			);
			await createWorkflowHistory(personalWorkflow);

			await authorAgent
				.post('/workflow-review-requests')
				.send({
					title: 'Personal review',
					workflows: [
						{
							workflowId: personalWorkflow.id,
							workflowVersionId: personalVersionId,
							workflowVersionName: 'v1',
						},
					],
				})
				.expect(200);

			const inbox = await authorAgent.get('/workflow-review-requests/inbox').expect(200);
			expect(inbox.body.data.data.map((i: { title: string }) => i.title)).toContain(
				'Personal review',
			);

			const summary = await authorAgent.get('/workflow-review-requests/summary').expect(200);
			expect(summary.body.data.open).toBeGreaterThanOrEqual(1);
		});

		it('rejects a malformed cursor with 400', async () => {
			await reviewerAgent
				.get('/workflow-review-requests/inbox')
				.query({ cursor: 'not-a-cursor' })
				.expect(400);
		});

		it('rejects an out-of-range limit with 400', async () => {
			await reviewerAgent.get('/workflow-review-requests/inbox').query({ limit: 500 }).expect(400);
		});
	});

	// ---- GET /:id ----

	describe('GET /workflow-review-requests/:id', () => {
		it('returns the detail with the pinned version and a null baseline', async () => {
			const review = await openReview();

			const response = await reviewerAgent
				.get(`/workflow-review-requests/${review.id}`)
				.expect(200);

			const detail = response.body.data;
			expect(detail.id).toBe(review.id);
			expect(detail.description).toBe('A description');
			expect(detail.workflows).toHaveLength(1);
			expect(detail.workflows[0].workflowId).toBe(workflow.id);
			expect(detail.workflows[0].workflowName).toBe('Reviewed workflow');
			expect(detail.workflows[0].pinnedVersion.versionId).toBe(pinnedVersionId);
			// Never published, so there is no diff baseline.
			expect(detail.workflows[0].baselineVersion).toBeNull();
		});

		it('resolves the baseline to the currently published version', async () => {
			const publishedVersionId = await addHistoryVersion(uuid(), true);
			await Container.get(WorkflowPublishedVersionRepository).setPublishedVersion(
				workflow.id,
				publishedVersionId,
			);
			const review = await openReview();

			const response = await reviewerAgent
				.get(`/workflow-review-requests/${review.id}`)
				.expect(200);
			expect(response.body.data.workflows[0].baselineVersion.versionId).toBe(publishedVersionId);
		});

		it('marks an eligible reviewer as able to decide', async () => {
			const review = await openReview();
			const response = await reviewerAgent
				.get(`/workflow-review-requests/${review.id}`)
				.expect(200);

			expect(response.body.data.viewerCanDecide).toBe(true);
			expect(response.body.data.viewerDecisionIneligibilityReason).toBeNull();
		});

		it('marks the author as ineligible with reason `author`', async () => {
			const review = await openReview();
			const response = await authorAgent.get(`/workflow-review-requests/${review.id}`).expect(200);

			expect(response.body.data.viewerCanDecide).toBe(false);
			expect(response.body.data.viewerDecisionIneligibilityReason).toBe('author');
		});

		it('marks a reader without publish rights as `missing_publish_permission`', async () => {
			const review = await openReview();
			const response = await viewerAgent.get(`/workflow-review-requests/${review.id}`).expect(200);

			expect(response.body.data.viewerCanDecide).toBe(false);
			expect(response.body.data.viewerDecisionIneligibilityReason).toBe(
				'missing_publish_permission',
			);
		});

		it('hides a review the caller cannot read with 404', async () => {
			const review = await openReview();
			await outsiderAgent.get(`/workflow-review-requests/${review.id}`).expect(404);
		});

		it('returns 404 for an unknown review', async () => {
			await reviewerAgent.get(`/workflow-review-requests/${uuid()}`).expect(404);
		});
	});

	// ---- publish guard ----

	describe('publish guard', () => {
		const assertCanPublish = async () =>
			await Container.get(WorkflowPublishGuardProxy).assertCanPublish(workflow.id);

		it('permits publishing when there is no review', async () => {
			await expect(assertCanPublish()).resolves.toBeUndefined();
		});

		it('blocks with reason review_pending while a review is open and undecided', async () => {
			const review = await openReview();
			await expect(assertCanPublish()).rejects.toMatchObject({
				httpStatusCode: 409,
				details: { reason: 'review_pending', workflowReviewRequestId: review.id },
			});
		});

		it('blocks with reason changes_requested after a change request', async () => {
			const review = await openReview();
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'changes_requested', expectedVersionId: pinnedVersionId })
				.expect(200);

			await expect(assertCanPublish()).rejects.toMatchObject({
				httpStatusCode: 409,
				details: { reason: 'changes_requested', workflowReviewRequestId: review.id },
			});
		});

		it('permits publishing once the review is approved and closed', async () => {
			const review = await openReview();
			vi.spyOn(Container.get(WorkflowService), 'activateWorkflow').mockResolvedValue(workflow);
			await reviewerAgent
				.post(`/workflow-review-requests/${review.id}/decision`)
				.send({ decision: 'approved', expectedVersionId: pinnedVersionId })
				.expect(200);

			await expect(assertCanPublish()).resolves.toBeUndefined();
		});

		it('permits publishing while an open review exists but the policy is off', async () => {
			await openReview();
			await Container.get(WorkflowReviewPolicyService).set(false);

			await expect(assertCanPublish()).resolves.toBeUndefined();
		});

		it('leaves the open review intact when the policy is turned off', async () => {
			const review = await openReview();
			await Container.get(WorkflowReviewPolicyService).set(false);

			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('open');
		});
	});

	// ---- lifecycle ----

	describe('lifecycle closure', () => {
		it('closes open reviews when the workflow is archived', async () => {
			const review = await openReview();

			await Container.get(WorkflowService).archive(owner, workflow.id);

			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('closed');
			// Closing for a lifecycle event is not a verdict, so the decision stands.
			expect(stored?.decision).toBe('pending');
		});

		it('stops blocking publication once the workflow was archived', async () => {
			await openReview();
			await Container.get(WorkflowService).archive(owner, workflow.id);

			await expect(
				Container.get(WorkflowPublishGuardProxy).assertCanPublish(workflow.id),
			).resolves.toBeUndefined();
		});

		it('closes open reviews when the workflow is moved to another project', async () => {
			const review = await openReview();
			const destination = await createTeamProject(`destination-${uuid()}`, owner);

			await Container.get(EnterpriseWorkflowService).transferWorkflow(
				owner,
				workflow.id,
				destination.id,
			);

			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('closed');
		});

		it('releases the workflow for a new review once it was archived', async () => {
			await openReview();
			await Container.get(WorkflowService).archive(owner, workflow.id);

			// Closing has to clear the open sentinel, or the workflow could never be
			// reviewed again after being archived and restored.
			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(200);
		});

		it('closes the review in the same transaction as the ownership change', async () => {
			const review = await openReview();
			const destination = await createTeamProject(`destination-${uuid()}`, owner);

			// A closure failure must take the transfer down with it: ownership in the
			// destination project plus a still-open review of the source project is
			// exactly the state that lets destination members decide it.
			const closure = vi
				.spyOn(Container.get(WorkflowReviewService), 'closeOpenReviewsForWorkflows')
				.mockRejectedValue(new Error('db down'));

			await expect(
				Container.get(EnterpriseWorkflowService).transferWorkflow(
					owner,
					workflow.id,
					destination.id,
				),
			).rejects.toThrow('db down');

			closure.mockRestore();

			const owningProject = await Container.get(SharedWorkflowRepository).getWorkflowOwningProject(
				workflow.id,
			);
			expect(owningProject?.id).toBe(project.id);

			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored?.state).toBe('open');
		});

		it('releases the workflow for a new review once it was transferred back', async () => {
			await openReview();
			const destination = await createTeamProject(`destination-${uuid()}`, owner);

			await Container.get(EnterpriseWorkflowService).transferWorkflow(
				owner,
				workflow.id,
				destination.id,
			);
			await linkUserToProject(author, destination, 'project:admin');

			await authorAgent.post('/workflow-review-requests').send(createPayload()).expect(200);
		});

		it('closes open reviews before the workflow is deleted', async () => {
			const review = await openReview();

			await Container.get(WorkflowService).delete(owner, workflow.id, true);

			// The request row itself cascades away with the workflow link, so the
			// observable outcome is that nothing is left blocking publication.
			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored === null || stored.state === 'closed').toBe(true);
		});

		it('aborts the deletion when the open reviews cannot be closed', async () => {
			await openReview();
			const closure = vi
				.spyOn(Container.get(WorkflowReviewService), 'closeOpenReviewsForWorkflows')
				.mockRejectedValue(new Error('db down'));

			await expect(Container.get(WorkflowService).delete(owner, workflow.id, true)).rejects.toThrow(
				'db down',
			);

			closure.mockRestore();
			await expect(
				Container.get(WorkflowRepository).findOneBy({ id: workflow.id }),
			).resolves.not.toBeNull();
		});

		it('removes the review request orphaned by the delete cascade', async () => {
			const review = await openReview();

			await Container.get(WorkflowService).delete(owner, workflow.id, true);

			// The cascade takes the child link but not its parent, which would
			// otherwise stay behind unreachable forever.
			const stored = await Container.get(WorkflowReviewRequestRepository).findRequestWithRelations(
				review.id,
				{},
			);
			expect(stored).toBeNull();
		});
	});
});
