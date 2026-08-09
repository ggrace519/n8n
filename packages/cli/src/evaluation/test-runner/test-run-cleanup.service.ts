import { Logger } from '@n8n/backend-common';
import { TestCaseExecutionRepository, TestRunErrorCode, TestRunRepository } from '@n8n/db';
import { Service } from '@n8n/di';

/**
 * Settles test runs a previous process left behind. Runs during single-main
 * startup: any `new`/`running` run found at boot belongs to a process that no
 * longer exists, so it can never finish — mark it interrupted and cancel its
 * pending cases so pollers see a terminal state instead of a forever-running
 * run.
 */
@Service()
export class TestRunCleanupService {
	constructor(
		private readonly logger: Logger,
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
	) {
		this.logger = this.logger.scoped('evaluation');
	}

	async cleanupIncompleteRuns(): Promise<void> {
		const incompleteRuns = await this.testRunRepository.findIncompleteRuns();
		if (incompleteRuns.length === 0) return;

		for (const run of incompleteRuns) {
			await this.testCaseExecutionRepository.markAllPendingAsCancelled(run.id);
			await this.testRunRepository.markAsError(run.id, TestRunErrorCode.INTERRUPTED, {
				message: 'The instance shut down before this test run finished.',
			});
		}
		this.logger.info(`Marked ${incompleteRuns.length} interrupted test run(s) as errored`);
	}
}
