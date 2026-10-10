import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';

import * as environmentsApi from './environments.api';
import type { VariablesListOptions } from './environments.api';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import type {
	CreateEnvironmentVariablePayload,
	EnvironmentVariable,
	UpdateEnvironmentVariablePayload,
} from './environments.types';

export const useEnvironmentsStore = defineStore('environments', () => {
	const rootStore = useRootStore();
	const workflowsStore = useWorkflowsStore();

	/** All variables visible to the current user (global + accessible projects). */
	const variables = ref<EnvironmentVariable[]>([]);

	/**
	 * The variables `$vars` sees for a workflow in the given project: all global
	 * variables plus that project's. This mirrors execution, where the backend
	 * resolves `$vars` against the workflow's owning project. Both a global and a
	 * project variable can share a key here — use {@link variablesAsObjectForProject}
	 * for the single resolved value.
	 */
	function variablesForProject(projectId: string | undefined): EnvironmentVariable[] {
		return variables.value.filter(
			(variable) => !variable.project || variable.project.id === projectId,
		);
	}

	/** {@link variablesForProject} as a `key -> value` map; a project variable overrides a global one. */
	function variablesAsObjectForProject(projectId: string | undefined): Record<string, string> {
		const globals: Record<string, string> = {};
		const projectScoped: Record<string, string> = {};
		for (const variable of variablesForProject(projectId)) {
			if (variable.project) {
				projectScoped[variable.key] = variable.value;
			} else {
				globals[variable.key] = variable.value;
			}
		}
		return { ...globals, ...projectScoped };
	}

	/** Home project of the workflow open in the editor (not the project in the URL). */
	const editorWorkflowProjectId = computed(
		() =>
			useWorkflowDocumentStore(createWorkflowDocumentId(workflowsStore.workflowId)).homeProject?.id,
	);

	/** Variables in scope for the workflow open in the editor. */
	const scopedVariables = computed(() => variablesForProject(editorWorkflowProjectId.value));

	/** `$vars` for the workflow open in the editor. */
	const variablesAsObject = computed(() =>
		variablesAsObjectForProject(editorWorkflowProjectId.value),
	);

	function setVariables(data: EnvironmentVariable[]) {
		variables.value = data;
	}

	async function fetchAllVariables(
		options: VariablesListOptions = {},
	): Promise<EnvironmentVariable[]> {
		const data = await environmentsApi.getVariables(rootStore.restApiContext, options);
		setVariables(data);
		return data;
	}

	async function createVariable(
		payload: CreateEnvironmentVariablePayload,
	): Promise<EnvironmentVariable> {
		const variable = await environmentsApi.createVariable(rootStore.restApiContext, payload);
		variables.value = [...variables.value, variable];
		return variable;
	}

	async function updateVariable(
		payload: UpdateEnvironmentVariablePayload,
	): Promise<EnvironmentVariable> {
		const variable = await environmentsApi.updateVariable(rootStore.restApiContext, payload);
		variables.value = variables.value.map((v) => (v.id === variable.id ? variable : v));
		return variable;
	}

	async function deleteVariable(variable: Pick<EnvironmentVariable, 'id'>): Promise<void> {
		await environmentsApi.deleteVariable(rootStore.restApiContext, { id: variable.id });
		variables.value = variables.value.filter((v) => v.id !== variable.id);
	}

	return {
		variables,
		scopedVariables,
		variablesAsObject,
		variablesForProject,
		variablesAsObjectForProject,
		setVariables,
		fetchAllVariables,
		createVariable,
		updateVariable,
		deleteVariable,
	};
});

// Consumers import this store both as a named and a default export; keep both.
// eslint-disable-next-line import-x/no-default-export
export default useEnvironmentsStore;
