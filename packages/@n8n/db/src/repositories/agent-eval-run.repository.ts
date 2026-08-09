import { Service } from '@n8n/di';
import { DataSource, In, type UpdateResult } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { AgentEvalRun } from '../entities';
import { BaseRepository } from './base-repository';

/** Attributes accepted when creating a run; optionals default to null. */
export type CreateAgentEvalRunAttrs = Pick<AgentEvalRun, 'datasetId'> &
	Partial<Pick<AgentEvalRun, 'agentVersionId' | 'createdById'>>;

/**
 * `take` of 0 is n8n's "no limit" idiom (`find` treats it as falsy), so the
 * window is applied the same way here rather than via `LIMIT 0`.
 */
export type AgentEvalPageParams = { take?: number; skip?: number };

/** Statuses a run can be left in by a process that died mid-run. */
const INCOMPLETE_STATUSES = ['new', 'running'] as const;

@Service()
export class AgentEvalRunRepository extends BaseRepository<AgentEvalRun> {
	constructor(dataSource: DataSource) {
		super(AgentEvalRun, dataSource.manager);
	}

	async createRun(attrs: CreateAgentEvalRunAttrs): Promise<AgentEvalRun> {
		const run = this.create({
			datasetId: attrs.datasetId,
			agentVersionId: attrs.agentVersionId ?? null,
			createdById: attrs.createdById ?? null,
			status: 'new',
			cancelRequested: false,
		});
		return await this.save(run);
	}

	async findById(id: string): Promise<AgentEvalRun | null> {
		return await this.findOne({ where: { id } });
	}

	/**
	 * A run scoped to the agent under test. A run has no agentId of its own, so
	 * this filters through the dataset it belongs to; a run of another agent's
	 * dataset resolves to null.
	 */
	async findByIdAndAgentId(id: string, agentId: string): Promise<AgentEvalRun | null> {
		return await this.findOne({ where: { id, dataset: { agentId } } });
	}

	/**
	 * A dataset's runs, newest first, as a page plus the total. The agent is part
	 * of the filter, not just the dataset id: a foreign caller must not read
	 * another agent's run history, and even a bare count would leak its size.
	 *
	 * Built as a join with explicit `offset`/`limit` rather than `find`'s
	 * `skip`/`take`, which switches a relation-filtered query onto TypeORM's
	 * DISTINCT sub-query path. A many-to-one join cannot multiply rows, so plain
	 * paging is both correct and portable. `createdAt` alone is not a stable
	 * order — runs started together share a millisecond — hence the id tiebreak.
	 */
	async findAndCountByDatasetIdAndAgentId(
		datasetId: string,
		agentId: string,
		page: AgentEvalPageParams = {},
	): Promise<[AgentEvalRun[], number]> {
		const query = this.createQueryBuilder('run')
			.innerJoin('run.dataset', 'dataset')
			.where('run.datasetId = :datasetId', { datasetId })
			.andWhere('dataset.agentId = :agentId', { agentId })
			.orderBy('run.createdAt', 'DESC')
			.addOrderBy('run.id', 'DESC');

		if (page.skip) query.offset(page.skip);
		if (page.take) query.limit(page.take);

		return await query.getManyAndCount();
	}

	async markAsRunning(id: string, runningInstanceId: string): Promise<UpdateResult> {
		return await this.update(id, { status: 'running', runAt: new Date(), runningInstanceId });
	}

	async markAsCompleted(id: string, metrics?: IDataObject | null): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'completed',
			completedAt: new Date(),
			...(metrics !== undefined ? { metrics } : {}),
		});
	}

	async markAsCancelled(id: string, metrics?: IDataObject | null): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'cancelled',
			completedAt: new Date(),
			...(metrics !== undefined ? { metrics } : {}),
		});
	}

	/**
	 * `metrics` is optional so an early failure (nothing ran yet) doesn't overwrite
	 * a tally with null, while a settled run can record both at once.
	 */
	async markAsError(
		id: string,
		errorCode: string,
		errorDetails?: IDataObject | null,
		metrics?: IDataObject | null,
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails: errorDetails ?? null,
			...(metrics !== undefined ? { metrics } : {}),
		});
	}

	/** Flag a run for cancellation; the executing main polls the flag. */
	async requestCancellation(id: string): Promise<UpdateResult> {
		return await this.update(id, { cancelRequested: true });
	}

	async isCancellationRequested(id: string): Promise<boolean> {
		return await this.exists({ where: { id, cancelRequested: true } });
	}

	/**
	 * Settle every run left unfinished by a previous process. The runner has no
	 * resume mechanism, so an incomplete run at startup would otherwise poll as
	 * `running` forever.
	 */
	async markAllIncompleteAsError(): Promise<UpdateResult> {
		return await this.update(
			{ status: In([...INCOMPLETE_STATUSES]) },
			{
				status: 'error',
				completedAt: new Date(),
				errorCode: 'interrupted',
				errorDetails: { message: 'The run was interrupted and did not finish.' },
			},
		);
	}
}
