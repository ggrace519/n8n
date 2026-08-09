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
			order: { createdAt: 'ASC' },
			skip: options.skip,
			take: options.take,
		});
	}

	async countByTestRunId(testRunId: string): Promise<number> {
		return await this.count({ where: { testRun: { id: testRunId } } });
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
