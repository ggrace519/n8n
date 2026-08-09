import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';

import * as environmentsApi from './environments.api';
import type { VariablesListOptions } from './environments.api';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type {
	CreateEnvironmentVariablePayload,
	EnvironmentVariable,
	UpdateEnvironmentVariablePayload,
} from './environments.types';

export const useEnvironmentsStore = defineStore('environments', () => {
	const rootStore = useRootStore();
	const projectsStore = useProjectsStore();

	/** All variables visible to the current user (global + accessible projects). */
	const variables = ref<EnvironmentVariable[]>([]);

	/**
	 * The variables that apply to the current project context: all global
	 * variables plus the variables of the project currently in scope. Both a
	 * global and a project variable can share a key here — consumers that need a
	 * single resolved value use {@link variablesAsObject}.
	 */
	const scopedVariables = computed<EnvironmentVariable[]>(() => {
		const projectId = projectsStore.currentProjectId;
		return variables.value.filter(
			(variable) => !variable.project || variable.project.id === projectId,
		);
	});

	/**
	 * The scoped variables resolved to a `key -> value` map for expression
	 * evaluation (`$vars`). A project variable overrides a global one of the
	 * same key.
	 */
	const variablesAsObject = computed<Record<string, string>>(() => {
		const globals: Record<string, string> = {};
		const projectScoped: Record<string, string> = {};
		for (const variable of scopedVariables.value) {
			if (variable.project) {
				projectScoped[variable.key] = variable.value;
			} else {
				globals[variable.key] = variable.value;
			}
		}
		return { ...globals, ...projectScoped };
	});

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
