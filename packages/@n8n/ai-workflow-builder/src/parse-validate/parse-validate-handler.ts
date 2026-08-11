import { parseWorkflowCode } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import type { INodeTypes } from 'n8n-workflow';

import { stripImportStatements } from './strip-import-statements';
import type { ParseValidateHandlerOptions, ValidationWarning } from './types';

export interface ParseValidateResult {
	/** The workflow parsed from the SDK code. */
	workflow: WorkflowJSON;
	/** Non-fatal issues found while validating the parsed workflow. */
	warnings: ValidationWarning[];
}

/**
 * Parses workflow SDK code into workflow JSON and validates the result.
 *
 * Parsing (SDK code → JSON) is delegated to `@n8n/workflow-sdk`'s
 * `parseWorkflowCode`, which throws a `WorkflowCodeParseError` on malformed
 * code — callers catch that to surface an SDK-reference hint. Validation adds
 * only non-fatal warnings (currently: node types that the instance does not
 * recognise); it never rejects an otherwise-parseable workflow.
 */
export class ParseValidateHandler {
	private readonly nodeTypes: INodeTypes;

	constructor(private readonly options: ParseValidateHandlerOptions) {
		this.nodeTypes = options.nodeTypesProvider;
	}

	/** Parse stripped SDK code to workflow JSON, then validate it. */
	async parseAndValidate(code: string): Promise<ParseValidateResult> {
		// Parsing is synchronous today, but the async signature is part of the
		// stable contract (callers `await` it and the real parser may do async work).
		await Promise.resolve();
		const workflow = parseWorkflowCode(stripImportStatements(code));
		const warnings = this.validateJSON(workflow);
		return { workflow, warnings };
	}

	/** Validate an already-parsed workflow JSON, returning any warnings. */
	validateJSON(workflow: WorkflowJSON): ValidationWarning[] {
		const warnings: ValidationWarning[] = [];
		const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];

		for (const node of nodes) {
			if (!this.isKnownNodeType(node.type, node.typeVersion)) {
				const label = node.name ?? node.id;
				warnings.push({
					code: 'unrecognized_node_type',
					message: `Node "${label}" uses an unrecognized node type "${node.type}". Check the type name and version, or search available nodes.`,
					nodeName: label,
				});
			}
		}

		return warnings;
	}

	private isKnownNodeType(type: string, typeVersion?: number): boolean {
		try {
			// getByNameAndVersion throws for unknown types; a returned value means
			// the type is registered on this instance.
			return Boolean(this.nodeTypes.getByNameAndVersion(type, typeVersion));
		} catch {
			return false;
		}
	}
}
