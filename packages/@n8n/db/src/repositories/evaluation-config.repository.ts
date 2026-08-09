import { Service } from '@n8n/di';
import { DataSource, Not } from '@n8n/typeorm';

import { EvaluationConfig } from '../entities';
import { BaseRepository } from './base-repository';

@Service()
export class EvaluationConfigRepository extends BaseRepository<EvaluationConfig> {
	constructor(dataSource: DataSource) {
		super(EvaluationConfig, dataSource.manager);
	}

	async findManyByWorkflowId(workflowId: string): Promise<EvaluationConfig[]> {
		return await this.find({ where: { workflowId }, order: { name: 'ASC' } });
	}

	/** Scoped lookup: a config id from another workflow resolves to null. */
	async findOneInWorkflow(configId: string, workflowId: string): Promise<EvaluationConfig | null> {
		return await this.findOne({ where: { id: configId, workflowId } });
	}

	/** Unique-name check within a workflow; `excludeId` skips the config being updated. */
	async existsByName(workflowId: string, name: string, excludeId?: string): Promise<boolean> {
		return await this.exists({
			where: { workflowId, name, ...(excludeId ? { id: Not(excludeId) } : {}) },
		});
	}
}
