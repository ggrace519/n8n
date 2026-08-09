import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { EvaluationCollection, TestRun } from '../entities';
import { BaseRepository } from './base-repository';

export type EvaluationCollectionWithRunCount = {
	collection: EvaluationCollection;
	runCount: number;
};

@Service()
export class EvaluationCollectionRepository extends BaseRepository<EvaluationCollection> {
	constructor(dataSource: DataSource) {
		super(EvaluationCollection, dataSource.manager);
	}

	/**
	 * Newest-first collections of a workflow, each paired with its attached-run
	 * count. A grouped count query replaces loading the run relation, which can
	 * be large.
	 */
	async findManyByWorkflowId(workflowId: string): Promise<EvaluationCollectionWithRunCount[]> {
		const collections = await this.find({ where: { workflowId }, order: { createdAt: 'DESC' } });
		if (collections.length === 0) return [];

		const rows = await this.manager
			.getRepository(TestRun)
			.createQueryBuilder('run')
			.select('run.collectionId', 'collectionId')
			.addSelect('COUNT(run.id)', 'runCount')
			.where('run.collectionId IN (:...collectionIds)', {
				collectionIds: collections.map((collection) => collection.id),
			})
			.groupBy('run.collectionId')
			.getRawMany<{ collectionId: string; runCount: string | number }>();

		const countById = new Map(rows.map((row) => [row.collectionId, Number(row.runCount)]));
		return collections.map((collection) => ({
			collection,
			runCount: countById.get(collection.id) ?? 0,
		}));
	}

	/** Scoped lookup: a collection id from another workflow resolves to null. */
	async findOneInWorkflow(
		collectionId: string,
		workflowId: string,
	): Promise<EvaluationCollection | null> {
		return await this.findOne({ where: { id: collectionId, workflowId } });
	}

	/** Same scoped lookup, with the attached runs loaded. */
	async findOneWithRunsInWorkflow(
		collectionId: string,
		workflowId: string,
	): Promise<EvaluationCollection | null> {
		return await this.findOne({
			where: { id: collectionId, workflowId },
			relations: { testRuns: true },
		});
	}

	/** Replace (or clear, with null) the cached AI-insights envelope. */
	async updateInsightsCache(
		collectionId: string,
		insightsCache: EvaluationCollection['insightsCache'],
	): Promise<void> {
		await this.update(collectionId, { insightsCache });
	}
}
