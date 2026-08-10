import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { AgentEvalRating } from '../entities';
import { BaseRepository } from './base-repository';

/** Attributes accepted when recording a rating; optionals default to null. */
export type CreateAgentEvalRatingAttrs = Pick<AgentEvalRating, 'resultId' | 'vote'> &
	Partial<Pick<AgentEvalRating, 'comment' | 'correction' | 'ratedById'>>;

@Service()
export class AgentEvalRatingRepository extends BaseRepository<AgentEvalRating> {
	constructor(dataSource: DataSource) {
		super(AgentEvalRating, dataSource.manager);
	}

	/** Ratings are append-only: a re-vote adds a row rather than replacing one. */
	async createRating(attrs: CreateAgentEvalRatingAttrs): Promise<AgentEvalRating> {
		const rating = this.create({
			resultId: attrs.resultId,
			vote: attrs.vote,
			comment: attrs.comment ?? null,
			correction: attrs.correction ?? null,
			ratedById: attrs.ratedById ?? null,
		});
		return await this.save(rating);
	}

	/** A case's full rating history, newest first. */
	async findByResultId(resultId: string): Promise<AgentEvalRating[]> {
		return await this.find({ where: { resultId }, order: { createdAt: 'DESC', id: 'DESC' } });
	}

	/**
	 * The newest rating per rated case in a run — what reopening a run renders.
	 * Unrated cases contribute nothing.
	 *
	 * Ratings hang off results, not runs, so the run filter needs the join. The
	 * newest-per-case pick is then made over the ordered rows in memory rather
	 * than in SQL: a `MAX(createdAt)` correlated sub-query returns *both* rows
	 * when two votes land in the same millisecond, and window functions are not
	 * uniformly available across the supported drivers. A run is bounded (500
	 * cases) and so is its rating history.
	 */
	async findLatestByRunId(runId: string): Promise<AgentEvalRating[]> {
		const ratings = await this.createQueryBuilder('rating')
			.innerJoin('rating.result', 'result')
			.where('result.runId = :runId', { runId })
			.orderBy('rating.createdAt', 'DESC')
			.addOrderBy('rating.id', 'DESC')
			.getMany();

		const latest = new Map<string, AgentEvalRating>();
		for (const rating of ratings) {
			if (!latest.has(rating.resultId)) latest.set(rating.resultId, rating);
		}
		return [...latest.values()];
	}
}
