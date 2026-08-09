import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { TestCaseExecution } from '../entities';
import { BaseRepository } from './base-repository';

@Service()
export class TestCaseExecutionRepository extends BaseRepository<TestCaseExecution> {
	constructor(dataSource: DataSource) {
		super(TestCaseExecution, dataSource.manager);
	}

	/** A test run's cases in stable creation order, paginated. */
	async getManyByTestRunId(
		testRunId: string,
		options: { skip?: number; take?: number } = {},
	): Promise<TestCaseExecution[]> {
		return await this.find({
			where: { testRun: { id: testRunId } },
			order: { createdAt: 'ASC', id: 'ASC' },
			skip: options.skip,
			take: options.take,
		});
	}

	async countByTestRunId(testRunId: string): Promise<number> {
		return await this.count({ where: { testRun: { id: testRunId } } });
	}

	async createTestCase(fields: {
		testRunId: string;
		runIndex?: number | null;
	}): Promise<TestCaseExecution> {
		const testCase = this.create({
			testRun: { id: fields.testRunId },
			status: 'new',
			runIndex: fields.runIndex ?? null,
		});
		return await this.save(testCase);
	}

	async markAsRunning(id: string, executionId?: string) {
		return await this.update(id, {
			status: 'running',
			runAt: new Date(),
			...(executionId !== undefined ? { executionId } : {}),
		});
	}

	async markAsCompleted(
		id: string,
		result: {
			metrics: TestCaseExecution['metrics'];
			inputs?: TestCaseExecution['inputs'];
			outputs?: TestCaseExecution['outputs'];
		},
	) {
		return await this.update(id, {
			status: 'success',
			completedAt: new Date(),
			metrics: result.metrics,
			inputs: result.inputs ?? null,
			outputs: result.outputs ?? null,
		});
	}

	async markAsError(
		id: string,
		errorCode: TestCaseExecution['errorCode'],
		errorDetails?: TestCaseExecution['errorDetails'],
	) {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails: errorDetails ?? null,
		});
	}

	async markAsCancelled(id: string) {
		return await this.update(id, { status: 'cancelled', completedAt: new Date() });
	}

	/** Mark every non-terminal case of a run as cancelled (run-level cancel/interrupt). */
	async markAllPendingAsCancelled(testRunId: string) {
		return await this.createQueryBuilder()
			.update()
			.set({ status: 'cancelled', completedAt: new Date() })
			.where('testRunId = :testRunId', { testRunId })
			.andWhere('status IN (:...statuses)', {
				statuses: ['new', 'running', 'evaluation_running'],
			})
			.execute();
	}
}
