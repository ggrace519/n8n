import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';

import { EVALUATION_TRIGGER_NODE_TYPE } from 'n8n-workflow';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { useUIStore } from '@/app/stores/ui.store';
import { ADD_EXECUTION_TO_DATASET_MODAL_KEY } from '@/app/constants';
import { useEvaluationsWizardSidepanelExperiment } from '@/experiments/evaluationsWizardSidepanel/useEvaluationsWizardSidepanelExperiment';
import { useEvaluationStore } from '../evaluation.store';

interface AddExecutionToDataset {
	/** Whether the "add execution to dataset" action is available at all. */
	isFeatureEnabled: ComputedRef<boolean>;
	/** Whether the workflow has an Evaluation Trigger backed by a data table. */
	hasDataTableConfig: ComputedRef<boolean>;
	/** Refreshes the evaluation configs used to resolve the target dataset. */
	fetchDataTableConfigs: () => Promise<void>;
	/** Opens the add-to-dataset modal seeded with the given execution. */
	openModal: (executionId: string) => void;
}

/**
 * Drives the "add this execution to a dataset" entry point on the executions
 * page. The action is only offered when the config-evals surface is enabled and
 * the workflow already has a data-table-backed Evaluation Trigger to add to.
 */
export function useAddExecutionToDataset(
	workflowId: MaybeRefOrGetter<string>,
): AddExecutionToDataset {
	const workflowDocumentStore = injectWorkflowDocumentStore();
	const uiStore = useUIStore();
	const evaluationStore = useEvaluationStore();
	const { isFeatureEnabled: isWizardEnabled } = useEvaluationsWizardSidepanelExperiment();

	const isFeatureEnabled = computed(() => isWizardEnabled.value);

	const hasDataTableConfig = computed(() =>
		(workflowDocumentStore.value.allNodes ?? []).some(
			(node) =>
				node.type === EVALUATION_TRIGGER_NODE_TYPE &&
				node.parameters?.source === 'dataTable' &&
				Boolean(node.parameters?.dataTableId),
		),
	);

	async function fetchDataTableConfigs() {
		const id = toValue(workflowId);
		if (!id) return;
		await evaluationStore.fetchEvaluationConfigs(id).catch(() => null);
	}

	function openModal(executionId: string) {
		uiStore.openModalWithData({
			name: ADD_EXECUTION_TO_DATASET_MODAL_KEY,
			data: { executionId, workflowId: toValue(workflowId) },
		});
	}

	return { isFeatureEnabled, hasDataTableConfig, fetchDataTableConfigs, openModal };
}
