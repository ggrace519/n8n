import type { AgentEvalResultStatus } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, type UpdateResult } from '@n8n/typeorm';
import type { IDataObject, JsonObject } from 'n8n-workflow';

import { AgentEvalResult } from '../entities';
import type { AgentEvalPageParams } from './agent-eval-run.repository';
import { BaseRepository } from './base-repository';

/** One case to seed; everything but the run is optional. */
export type SeedAgentEvalResultAttrs = Pick<AgentEvalResult, 'runId'> &
	Partial<Pick<AgentEvalResult, 'sourceRowId' | 'runIndex' | 'input'>>;

export type AgentEvalResultStatusCounts = Record<AgentEvalResultStatus, number>;

const RESULT_STATUSES: AgentEvalResultStatus[] = [
	'new',
	'running',
	'success',
	'error',
	'cancelled',
];

const zeroCounts = (): AgentEvalResultStatusCounts => ({
	new: 0,
	running: 0,
	success: 0,
	error: 0,
	cancelled: 0,
});

@Service()
export class AgentEvalResultRepository extends BaseRepository<AgentEvalResult> {
	constructor(dataSource: DataSource) {
		super(AgentEvalResult, dataSource.manager);
	}

	/**
	 * Create one `new` result row per case, up front, so a run's progress is
	 * pollable before any case has executed.
	 *
	 * **Returns the rows in the order the cases were given** — the runner pairs
	 * `seeded[i]` with `cases[i]`. Keep any reimplementation order-preserving
	 * (`save` of an array is); an `insert` + re-read would silently mis-pair.
	 */
	async seedResults(cases: SeedAgentEvalResultAttrs[]): Promise<AgentEvalResult[]> {
		const rows = cases.map((c) =>
			this.create({
				runId: c.runId,
				sourceRowId: c.sourceRowId ?? null,
				runIndex: c.runIndex ?? null,
				input: c.input ?? null,
				status: 'new',
			}),
		);
		return await this.save(rows);
	}

	async findById(id: string): Promise<AgentEvalResult | null> {
		return await this.findOne({ where: { id } });
	}

	/**
	 * A page of a run's cases in seed order, plus the run's total. Ordered by
	 * `runIndex` rather than `createdAt`: seeding inserts every case in one
	 * statement, so they share a timestamp and the fallback tiebreak would be the
	 * (non-monotonic) generated id.
	 */
	async findAndCountByRunId(
		runId: string,
		page: AgentEvalPageParams = {},
	): Promise<[AgentEvalResult[], number]> {
		return await this.findAndCount({
			where: { runId },
			order: { runIndex: 'ASC', createdAt: 'ASC', id: 'ASC' },
			skip: page.skip,
			take: page.take,
		});
	}

	/**
	 * Per-status tally for a run, counted in the database — this is polled while a
	 * run is in flight, so the per-case JSON must never be loaded to count it.
	 * Statuses absent from the run still report 0, so callers can sum all five.
	 */
	async countByStatus(runId: string): Promise<AgentEvalResultStatusCounts> {
		const rows = await this.createQueryBuilder('result')
			.select('result.status', 'status')
			.addSelect('COUNT(*)', 'count')
			.where('result.runId = :runId', { runId })
			.groupBy('result.status')
			.getRawMany<{ status: AgentEvalResultStatus; count: string | number }>();

		const counts = zeroCounts();
		for (const row of rows) {
			if (RESULT_STATUSES.includes(row.status)) counts[row.status] = Number(row.count);
		}
		return counts;
	}

	async markAsRunning(id: string): Promise<UpdateResult> {
		return await this.update(id, { status: 'running', runAt: new Date() });
	}

	async markAsCompleted(
		id: string,
		result: {
			output: JsonObject | null;
			toolCalls: JsonObject | null;
			metrics: IDataObject | null;
		},
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'success',
			completedAt: new Date(),
			output: result.output,
			toolCalls: result.toolCalls,
			metrics: result.metrics,
		});
	}

	async markAsError(
		id: string,
		errorCode: string,
		errorDetails?: IDataObject | null,
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails: errorDetails ?? null,
		});
	}

	async markAsCancelled(id: string): Promise<UpdateResult> {
		return await this.update(id, { status: 'cancelled', completedAt: new Date() });
	}
}
