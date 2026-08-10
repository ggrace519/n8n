import { computed, type ComputedRef } from 'vue';

import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import type { INodeUi } from '@/Interface';

/**
 * The AI "root" nodes on the current canvas — nodes categorised as AI that emit
 * a main output (agents, chains), as opposed to AI sub-nodes (models, tools,
 * memory) that only connect over `ai_*` connections. These are the nodes the
 * evaluation setup wizard can target as the system under test.
 */
export function useAiRootNodes(): ComputedRef<INodeUi[]> {
	const workflowDocumentStore = injectWorkflowDocumentStore();
	const nodeTypesStore = useNodeTypesStore();

	return computed(() =>
		(workflowDocumentStore.value.allNodes ?? []).filter((node) => {
			const nodeType = nodeTypesStore.getNodeType(node.type, node.typeVersion);
			if (!nodeType?.codex?.categories?.includes('AI')) return false;
			// A root node produces a main output; sub-nodes expose only `ai_*`
			// outputs. Treat a non-array (expression-driven) outputs value as a root.
			const outputs = nodeType.outputs;
			if (!Array.isArray(outputs)) return true;
			return outputs.some((output) =>
				typeof output === 'string' ? output === 'main' : output?.type === 'main',
			);
		}),
	);
}
