import { StartTestRunRequestDto } from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { TestCaseExecutionRepository, TestRunRepository } from '@n8n/db';
import { Body, Delete, Get, Param, Post, RestController } from '@n8n/decorators';
import type { Scope } from '@n8n/permissions';
import type { Response } from 'express';
import { ErrorReporter } from 'n8n-core';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { TestRunnerService } from '@/evaluation/test-runner/test-runner.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

@RestController('/workflows/:workflowId/test-runs')
export class TestRunsController {
	constructor(
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
		private readonly testRunnerService: TestRunnerService,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly errorReporter: ErrorReporter,
	) {}

	/**
	 * Resolve the workflow through the user's project/sharing access. Missing
	 * workflow and insufficient access both surface as 404 so the route never
	 * confirms a workflow the caller can't see.
	 */
	private async assertWorkflowAccess(user: User, workflowId: string, scopes: Scope[]) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, scopes);
		if (!workflow) throw new NotFoundError('Workflow not found');
		return workflow;
	}

	/** Scoped lookup: a run id from another workflow 404s instead of leaking. */
	private async assertTestRunInWorkflow(workflowId: string, testRunId: string) {
		if (!(await this.testRunRepository.existsInWorkflow(testRunId, workflowId))) {
			throw new NotFoundError('Test run not found');
		}
	}

	@Get('/')
	async getMany(
		req: AuthenticatedRequest<{ workflowId: string }, {}, {}, { take?: string; skip?: string }>,
		_res: Response,
		@Param('workflowId') workflowId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		const take = req.query.take ? Number(req.query.take) : undefined;
		const skip = req.query.skip ? Number(req.query.skip) : undefined;
		return await this.testRunRepository.getMany(workflowId, { skip, take });
	}

	@Get('/:testRunId')
	async getOne(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('testRunId') testRunId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		const testRun = await this.testRunRepository.getTestRunSummaryByWorkflowId(
			testRunId,
			workflowId,
		);
		if (!testRun) throw new NotFoundError('Test run not found');
		return testRun;
	}

	@Get('/:testRunId/test-cases')
	async getTestCases(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('testRunId') testRunId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:read']);
		await this.assertTestRunInWorkflow(workflowId, testRunId);
		return await this.testCaseExecutionRepository.getManyByTestRunId(testRunId, {});
	}

	@Delete('/:testRunId')
	async delete(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('workflowId') workflowId: string,
		@Param('testRunId') testRunId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:update']);
		await this.assertTestRunInWorkflow(workflowId, testRunId);
		await this.testRunRepository.delete({ id: testRunId });
		return { success: true };
	}

	@Post('/:testRunId/cancel')
	async cancel(
		req: AuthenticatedRequest,
		res: Response,
		@Param('workflowId') workflowId: string,
		@Param('testRunId') testRunId: string,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:execute']);
		await this.assertTestRunInWorkflow(workflowId, testRunId);
		await this.testRunnerService.cancelTestRun(testRunId);
		res.status(202).json({ success: true });
	}

	@Post('/new')
	async create(
		req: AuthenticatedRequest,
		res: Response,
		@Param('workflowId') workflowId: string,
		@Body body: StartTestRunRequestDto,
	) {
		await this.assertWorkflowAccess(req.user, workflowId, ['workflow:execute']);

		const { concurrency = 1, ...rest } = body;
		const options = Object.keys(rest).length > 0 ? rest : undefined;

		const { testRun, finished } = await this.testRunnerService.startTestRun(
			req.user,
			workflowId,
			concurrency,
			options,
		);
		// Case execution runs detached; route a late rejection to the error
		// reporter instead of leaving it unhandled.
		void finished.catch((error: unknown) => this.errorReporter.error(error));

		res.status(202).json({ success: true, testRunId: testRun.id });
	}
}
