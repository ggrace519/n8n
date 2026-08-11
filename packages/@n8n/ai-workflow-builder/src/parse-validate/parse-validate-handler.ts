import {
	parseWorkflowCodeToBuilder,
	validateWorkflow,
	type ValidationWarning,
	type WorkflowJSON,
} from '@n8n/workflow-sdk';
import type { INodeTypes } from 'n8n-workflow';

import { WorkflowCodeParseError, WorkflowValidationError } from './errors';

export interface ParseValidateHandlerOptions {
	/**
	 * Populate example input data on each node after parsing. Off for the MCP
	 * tools, which persist what they parse and must not invent run data.
	 */
	generatePinData: boolean;
	/** Resolves node types so validation can check parameters and connections. */
	nodeTypesProvider: INodeTypes;
}

export interface ParseValidateResult {
	workflow: WorkflowJSON;
	warnings: ValidationWarning[];
}

/**
 * Turns workflow SDK code into validated workflow JSON.
 *
 * Orchestration only — parsing and validation both live in `@n8n/workflow-sdk`.
 *
 * Errors are **thrown, not returned**: callers report a failure from their
 * `catch`, and there is no error field on the result. A handler that returned
 * `{ workflow, errors }` on invalid input would let a caller that only reads
 * `workflow` persist a broken workflow without noticing.
 */
export class ParseValidateHandler {
	constructor(private readonly options: ParseValidateHandlerOptions) {}

	/**
	 * @throws {WorkflowCodeParseError} the code is not interpretable SDK code
	 * @throws {WorkflowValidationError} it parsed but the workflow is invalid
	 */
	// Async by contract: callers await it, and the real agent's variant resolves
	// node types over the network. Parsing happens to be synchronous today.
	// eslint-disable-next-line @typescript-eslint/require-await
	async parseAndValidate(code: string): Promise<ParseValidateResult> {
		let builder;
		try {
			builder = parseWorkflowCodeToBuilder(code);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowCodeParseError(`Failed to parse generated workflow code: ${message}`, {
				cause: error,
			});
		}

		if (this.options.generatePinData) builder = builder.generatePinData();

		const result = validateWorkflow(builder, {
			nodeTypesProvider: this.options.nodeTypesProvider,
		});

		if (result.errors.length > 0) {
			throw new WorkflowValidationError(result.errors.map((error) => error.message));
		}

		return { workflow: builder.toJSON(), warnings: result.warnings };
	}

	/**
	 * Validate an already-parsed workflow. Returns warnings rather than throwing
	 * — callers use this to diff warnings before and after an edit, so an
	 * invalid intermediate state has to be inspectable rather than fatal.
	 */
	validateJSON(workflow: WorkflowJSON): ValidationWarning[] {
		return validateWorkflow(workflow, {
			nodeTypesProvider: this.options.nodeTypesProvider,
		}).warnings;
	}
}
