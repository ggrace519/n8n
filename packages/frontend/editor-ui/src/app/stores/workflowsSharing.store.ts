import { computed } from 'vue';
import { defineStore } from 'pinia';
import { STORES } from '@n8n/stores';
import { useRootStore } from '@n8n/stores/useRootStore';
import type { IWorkflowDb } from '@/Interface';
import type { ProjectSharingData } from '@/features/collaboration/projects/projects.types';
import { splitName } from '@/features/collaboration/projects/projects.utils';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import * as workflowsSharingApi from '@/app/api/workflows.sharing';

/**
 * Workflow sharing state & actions. Kept separate from the main workflow
 * stores so the sharing surface (owner lookup + share persistence) stays
 * cohesive and can be consumed by the sharing modal and workflow settings.
 */
export const useWorkflowSharingStore = defineStore(STORES.WORKFLOWS_EE, () => {
	const rootStore = useRootStore();
	const workflowsListStore = useWorkflowsListStore();

	/**
	 * Human-readable owner (home project) name for a workflow, falling back to
	 * the provided string when the workflow or its owner cannot be resolved.
	 */
	const getWorkflowOwnerName = computed(() => {
		return (workflowId: string, fallback = 'unknown'): string => {
			const workflow = workflowsListStore.getWorkflowById(workflowId);
			const { name, email } = splitName(workflow?.homeProject?.name ?? '');

			if (name) {
				return email ? `${name} (${email})` : name;
			}

			return email ?? fallback;
		};
	});

	/**
	 * Persist the set of projects a workflow is shared with and reflect the
	 * change in the workflow list cache.
	 */
	const saveWorkflowSharedWith = async (payload: {
		sharedWithProjects: ProjectSharingData[];
		workflowId: string;
	}): Promise<IWorkflowDb> => {
		const workflow = await workflowsSharingApi.setWorkflowSharedWith(
			rootStore.restApiContext,
			payload.workflowId,
			{
				shareWithIds: payload.sharedWithProjects.map((project) => project.id),
			},
		);

		workflowsListStore.updateWorkflowInCache(payload.workflowId, {
			sharedWithProjects: payload.sharedWithProjects,
		});

		return workflow;
	};

	return {
		getWorkflowOwnerName,
		saveWorkflowSharedWith,
	};
});
