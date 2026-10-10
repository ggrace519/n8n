import { WorkflowRepository, type User, type WorkflowEntity } from '@n8n/db';
import { Service } from '@n8n/di';
import { UnexpectedError } from 'n8n-workflow';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

/**
 * A package workflow id that already exists in the instance. The location and
 * name are reported only when the importing user can read that workflow;
 * otherwise only the collision itself is.
 */
export interface WorkflowIdConflict {
	sourceWorkflowId: string;
	existingWorkflowId: string;
	/** Owning project of the existing workflow; null when no owner share exists or it is not readable. */
	existingProjectId: string | null;
	isArchived?: boolean;
	name?: string;
}

@Service()
export class WorkflowImportMatchService {
	constructor(
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly workflowRepository: WorkflowRepository,
	) {}

	/** Collisions of `workflowIds` with existing workflows, redacted to what `user` may read. */
	async findIdConflicts(workflowIds: string[], user: User): Promise<WorkflowIdConflict[]> {
		const existing = await this.findOwningProjectsByWorkflowId(workflowIds);
		if (existing.size === 0) return [];

		const readable = await this.workflowFinderService.findWorkflowIdsWithScopeForUser(
			[...existing.keys()],
			user,
			['workflow:read'],
		);

		return workflowIds.flatMap((id) => {
			const location = existing.get(id);
			if (!location) return [];
			const conflict: WorkflowIdConflict = {
				sourceWorkflowId: id,
				existingWorkflowId: id,
				existingProjectId: null,
			};
			if (readable.has(id)) {
				conflict.existingProjectId = location.projectId;
				conflict.isArchived = location.isArchived;
				conflict.name = location.name;
			}
			return [conflict];
		});
	}

	async findOwningProjectsByWorkflowId(
		workflowIds: string[],
	): Promise<Map<string, { projectId: string | null; name: string; isArchived: boolean }>> {
		if (workflowIds.length === 0) return new Map();

		const workflows = await this.workflowRepository.findPreExistingWorkflows(workflowIds);

		return new Map(
			workflows.map((workflow) => [
				workflow.id,
				{
					projectId: workflow.shared?.[0]?.projectId ?? null,
					name: workflow.name,
					isArchived: workflow.isArchived,
				},
			]),
		);
	}

	async findBySourceWorkflowIds(
		projectId: string,
		sourceWorkflowIds: string[],
	): Promise<Map<string, WorkflowEntity>> {
		if (sourceWorkflowIds.length === 0) return new Map();

		const packageWorkflowIds = new Set(sourceWorkflowIds);
		const finderOptions = { includeActiveVersion: true, includeParentFolder: true } as const;
		const matchBySourceWorkflowId = new Map<string, WorkflowEntity>();

		const workflows = await this.workflowFinderService.findOwnedWorkflowsBySourceWorkflowIds(
			projectId,
			sourceWorkflowIds,
			finderOptions,
		);

		for (const workflow of workflows) {
			if (!workflow.sourceWorkflowId) continue;

			const key = workflow.sourceWorkflowId;
			if (!packageWorkflowIds.has(key)) continue;

			if (matchBySourceWorkflowId.has(key)) {
				throw new UnexpectedError(
					'Multiple workflows in the target project share the same sourceWorkflowId',
					{ extra: { projectId, sourceWorkflowId: key } },
				);
			}

			matchBySourceWorkflowId.set(key, workflow);
		}

		for (const workflow of workflows) {
			if (workflow.sourceWorkflowId !== null) continue;

			const key = workflow.id;
			if (!packageWorkflowIds.has(key) || matchBySourceWorkflowId.has(key)) continue;

			matchBySourceWorkflowId.set(key, workflow);
		}

		return matchBySourceWorkflowId;
	}
}
