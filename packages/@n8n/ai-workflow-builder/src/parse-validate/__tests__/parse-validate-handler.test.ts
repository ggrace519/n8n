import type { INodeType, INodeTypes } from 'n8n-workflow';

import { WorkflowCodeParseError, WorkflowValidationError } from '../errors';
import { ParseValidateHandler } from '../parse-validate-handler';
import { getWarningKey } from '../warning-key';

/** Minimal provider: validation only needs node types to be resolvable. */
const nodeTypesProvider: INodeTypes = {
	getByName: () => ({}) as INodeType,
	getByNameAndVersion: () => ({}) as INodeType,
	getKnownTypes: () => ({}),
};

/** Declares a parameter that refuses `placeholder()`, which is a fatal error. */
const strictNodeTypesProvider: INodeTypes = {
	...nodeTypesProvider,
	getByNameAndVersion: () =>
		({
			description: {
				properties: [{ name: 'url', builderHint: { placeholderSupported: false } }],
			},
		}) as unknown as INodeType,
};

const handler = new ParseValidateHandler({ generatePinData: false, nodeTypesProvider });

const TRIGGER = "trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: {} })";

describe('ParseValidateHandler', () => {
	describe('parseAndValidate', () => {
		it('turns SDK code into workflow JSON', async () => {
			const result = await handler.parseAndValidate(
				`export default workflow('wf-id', 'My Workflow').add(${TRIGGER})`,
			);

			expect(result.workflow.name).toBe('My Workflow');
			expect(result.workflow.nodes).toHaveLength(1);
			expect(result.workflow.nodes[0].type).toBe('n8n-nodes-base.manualTrigger');
			expect(Array.isArray(result.warnings)).toBe(true);
		});

		it('reports warnings without failing', async () => {
			// No trigger node — a warning, not an error.
			const result = await handler.parseAndValidate(
				"export default workflow('wf-id', 'My Workflow')",
			);

			expect(result.warnings.map((w) => w.code)).toContain('MISSING_TRIGGER');
		});

		/**
		 * The branch that matters most: `create_workflow_from_code` reads only
		 * `result.workflow` and persists it. If a workflow with fatal errors came
		 * back as a value instead of a throw, that caller would write it to the
		 * database without ever looking at the errors.
		 */
		it('throws rather than returning a workflow that failed validation', async () => {
			const strict = new ParseValidateHandler({
				generatePinData: false,
				nodeTypesProvider: strictNodeTypesProvider,
			});
			const code = `export default workflow('wf-id', 'My Workflow').add(${TRIGGER}.to(node({ type: 'n8n-nodes-base.httpRequest', version: 1, config: { parameters: { url: placeholder('the endpoint') } } })))`;

			const error = await strict.parseAndValidate(code).catch((e: Error) => e);

			expect(error).toBeInstanceOf(WorkflowValidationError);
			expect((error as WorkflowValidationError).errors.join(' ')).toContain('placeholder()');
		});

		it('throws rather than returning a partial workflow for unparseable code', async () => {
			await expect(handler.parseAndValidate('this is not SDK code {{{')).rejects.toThrow(
				WorkflowCodeParseError,
			);
		});

		/**
		 * `getSdkReferenceHint` in packages/cli keys on this exact name to decide
		 * whether to tell the client to go read the SDK reference. Renaming the
		 * class drops the hint and leaves a failing client with no way forward.
		 */
		it('names parse failures WorkflowCodeParseError', async () => {
			const error = await handler.parseAndValidate('nonsense(((').catch((e: Error) => e);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe('WorkflowCodeParseError');
			expect((error as Error).message).toContain('Failed to parse generated workflow code');
		});

		it('keeps the underlying failure as the cause', async () => {
			const error = await handler.parseAndValidate('nonsense(((').catch((e: Error) => e);

			expect(error).toHaveProperty('cause');
		});
	});

	describe('validateJSON', () => {
		it('returns warnings for an already-parsed workflow', () => {
			const warnings = handler.validateJSON({
				name: 'My Workflow',
				nodes: [],
				connections: {},
			} as never);

			expect(warnings.map((w) => w.code)).toContain('MISSING_TRIGGER');
		});
	});
});

describe('getWarningKey', () => {
	it('identifies a warning by code, node and parameter', () => {
		expect(
			getWarningKey({
				code: 'INVALID_PARAMETER',
				nodeName: 'HTTP Request',
				parameterPath: 'options.retry',
			}),
		).toBe('INVALID_PARAMETER|HTTP Request|options.retry');
	});

	it('renders absent node and parameter as empty segments', () => {
		expect(getWarningKey({ code: 'MISSING_TRIGGER' })).toBe('MISSING_TRIGGER||');
	});

	it('ignores the message, so rewording a warning does not make it look new', () => {
		const shared = { code: 'INVALID_PARAMETER', nodeName: 'N', parameterPath: 'p' } as const;
		const before = { ...shared, message: 'before' };
		const after = { ...shared, message: 'after' };

		expect(getWarningKey(before)).toBe(getWarningKey(after));
	});

	it('separates warnings differing only in node', () => {
		expect(getWarningKey({ code: 'DISCONNECTED_NODE', nodeName: 'A' })).not.toBe(
			getWarningKey({ code: 'DISCONNECTED_NODE', nodeName: 'B' }),
		);
	});
});
