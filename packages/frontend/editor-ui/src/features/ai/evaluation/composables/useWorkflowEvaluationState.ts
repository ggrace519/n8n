import { computed, type ComputedRef } from 'vue';

import { EVALUATION_NODE_TYPE, EVALUATION_TRIGGER_NODE_TYPE } from 'n8n-workflow';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import type { INodeUi } from '@/Interface';

interface WorkflowEvaluationState {
	/** An Evaluation Trigger node is present on the canvas. */
	evaluationTriggerExists: ComputedRef<boolean>;
	/** An Evaluation node configured with the `setMetrics` operation is present. */
	evaluationSetMetricsNodeExist: ComputedRef<boolean>;
	/** An Evaluation node configured with the `setOutputs` operation is present. */
	evaluationSetOutputsNodeExist: ComputedRef<boolean>;
	/** Maps each configured metric name to the Evaluation node that sets it. */
	metricSourceByKey: ComputedRef<Record<string, string>>;
}

function isEvaluationNodeWithOperation(node: INodeUi, operation: string): boolean {
	return node.type === EVALUATION_NODE_TYPE && node.parameters?.operation === operation;
}

/**
 * Derives evaluation-related canvas state (which evaluation nodes exist and how
 * they are configured) for the current workflow. Used to gate the production
 * checklist and the setup wizard on what the user has already wired up.
 */
export function useWorkflowEvaluationState(): WorkflowEvaluationState {
	const workflowDocumentStore = injectWorkflowDocumentStore();

	const nodes = computed<INodeUi[]>(() => workflowDocumentStore.value.allNodes ?? []);

	const evaluationTriggerExists = computed(() =>
		nodes.value.some((node) => node.type === EVALUATION_TRIGGER_NODE_TYPE),
	);

	const evaluationSetMetricsNodeExist = computed(() =>
		nodes.value.some((node) => isEvaluationNodeWithOperation(node, 'setMetrics')),
	);

	const evaluationSetOutputsNodeExist = computed(() =>
		nodes.value.some((node) => isEvaluationNodeWithOperation(node, 'setOutputs')),
	);

	const metricSourceByKey = computed<Record<string, string>>(() => {
		const result: Record<string, string> = {};
		for (const node of nodes.value) {
			if (!isEvaluationNodeWithOperation(node, 'setMetrics')) continue;
			const metrics = node.parameters?.metrics;
			if (!metrics || typeof metrics !== 'object') continue;
			// The metrics parameter is a fixed-collection; its inner arrays carry
			// entries with a `name`. Read defensively — the shape can vary by version.
			for (const value of Object.values(metrics as Record<string, unknown>)) {
				if (!Array.isArray(value)) continue;
				for (const entry of value) {
					const name = (entry as { name?: unknown })?.name;
					if (typeof name === 'string' && name) {
						result[name] = node.name;
					}
				}
			}
		}
		return result;
	});

	return {
		evaluationTriggerExists,
		evaluationSetMetricsNodeExist,
		evaluationSetOutputsNodeExist,
		metricSourceByKey,
	};
}
