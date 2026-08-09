import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

import { WorkflowTagMapping } from '../entities';

@Service()
export class WorkflowTagMappingRepository extends Repository<WorkflowTagMapping> {
	constructor(dataSource: DataSource) {
		super(WorkflowTagMapping, dataSource.manager);
	}

	/** All tag-to-workflow mappings, e.g. for the source-control tags export. */
	async findAllMappings(): Promise<Array<Pick<WorkflowTagMapping, 'tagId' | 'workflowId'>>> {
		return await this.find({ select: ['tagId', 'workflowId'] });
	}

	/** Tag mappings restricted to the given workflows, e.g. for a scoped source-control export. */
	async findMappingsForWorkflows(
		workflowIds: string[],
	): Promise<Array<Pick<WorkflowTagMapping, 'tagId' | 'workflowId'>>> {
		if (workflowIds.length === 0) return [];
		return await this.find({
			select: ['tagId', 'workflowId'],
			where: { workflowId: In(workflowIds) },
		});
	}

	async overwriteTaggings(workflowId: string, tagIds: string[]) {
		return await this.manager.transaction(async (tx) => {
			await tx.delete(WorkflowTagMapping, { workflowId });

			const taggings = tagIds.map((tagId) => this.create({ workflowId, tagId }));

			return await tx.insert(WorkflowTagMapping, taggings);
		});
	}
}
