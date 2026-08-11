import type { INodeTypes } from 'n8n-workflow';

/**
 * A non-fatal issue found while validating generated workflow code or JSON.
 * `code` identifies the class of warning; `nodeName`/`parameterPath` locate it.
 */
export interface ValidationWarning {
	/** Machine-readable warning class (e.g. `unrecognized_node_type`). */
	code: string;
	/** Human-readable explanation. */
	message: string;
	/** Node the warning applies to, if node-scoped. */
	nodeName?: string;
	/** Parameter path the warning applies to, if parameter-scoped. */
	parameterPath?: string;
}

export interface ParseValidateHandlerOptions {
	/**
	 * Reserved for synthesising pin data for trigger nodes. The current callers
	 * pass `false`; parsed pin data (from SDK `output` fields) is preserved
	 * either way.
	 */
	generatePinData?: boolean;
	/** Node type registry used to validate that referenced node types exist. */
	nodeTypesProvider: INodeTypes;
}
