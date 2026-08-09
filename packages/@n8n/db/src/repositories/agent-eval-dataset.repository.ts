import type { UpdateAgentEvalDatasetPayload } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { AgentEvalDataset } from '../entities';
import { BaseRepository } from './base-repository';

/** Attributes accepted when creating a dataset; optionals default to null. */
export type CreateAgentEvalDatasetAttrs = Pick<
	AgentEvalDataset,
	'name' | 'agentId' | 'datasetSource' | 'datasetRef'
> &
	Partial<Pick<AgentEvalDataset, 'description' | 'columnMapping' | 'createdById'>>;

@Service()
export class AgentEvalDatasetRepository extends BaseRepository<AgentEvalDataset> {
	constructor(dataSource: DataSource) {
		super(AgentEvalDataset, dataSource.manager);
	}

	async createDataset(attrs: CreateAgentEvalDatasetAttrs): Promise<AgentEvalDataset> {
		const dataset = this.create({
			name: attrs.name,
			description: attrs.description ?? null,
			agentId: attrs.agentId,
			datasetSource: attrs.datasetSource,
			datasetRef: attrs.datasetRef,
			columnMapping: attrs.columnMapping ?? null,
			createdById: attrs.createdById ?? null,
		});
		return await this.save(dataset);
	}

	async findById(id: string): Promise<AgentEvalDataset | null> {
		return await this.findOne({ where: { id } });
	}

	/** Scoped lookup: a dataset id belonging to another agent resolves to null. */
	async findByIdAndAgentId(id: string, agentId: string): Promise<AgentEvalDataset | null> {
		return await this.findOne({ where: { id, agentId } });
	}

	/** An agent's datasets, newest first. */
	async findByAgentId(agentId: string): Promise<AgentEvalDataset[]> {
		return await this.find({ where: { agentId }, order: { createdAt: 'DESC', id: 'DESC' } });
	}

	/**
	 * Patch a dataset's metadata, scoped to its agent — another agent's id patches
	 * nothing and resolves to null so callers can 404 without leaking existence.
	 *
	 * Only keys actually present in the payload are written, so `description: null`
	 * (clear it) stays distinguishable from an omitted `description` (leave it).
	 * An empty payload is a legal no-op patch, not a 500 from an empty UPDATE.
	 */
	async updateDataset(
		id: string,
		agentId: string,
		payload: UpdateAgentEvalDatasetPayload,
	): Promise<AgentEvalDataset | null> {
		const existing = await this.findByIdAndAgentId(id, agentId);
		if (!existing) return null;

		const patch: Partial<AgentEvalDataset> = {};
		if (payload.name !== undefined) patch.name = payload.name;
		if (payload.description !== undefined) patch.description = payload.description;
		if (payload.columnMapping !== undefined) patch.columnMapping = payload.columnMapping;

		if (Object.keys(patch).length === 0) return existing;

		await this.update({ id, agentId }, patch);
		return await this.findByIdAndAgentId(id, agentId);
	}

	/** Returns whether a row was removed; false means the id is not this agent's. */
	async deleteDataset(id: string, agentId: string): Promise<boolean> {
		const result = await this.delete({ id, agentId });
		return (result.affected ?? 0) > 0;
	}
}
