/**
 * Raised when workflow SDK code cannot be interpreted at all.
 *
 * The name is load-bearing: `getSdkReferenceHint` in `packages/cli` keys on it
 * to decide whether to point the caller at the SDK reference. Renaming this
 * class silently drops that hint, so a client that emitted malformed code gets
 * a bare error instead of the instructions it needs to recover.
 *
 * That hint accepts **either** `error.name === 'WorkflowCodeParseError'` **or**
 * `error instanceof SyntaxError`, and `@n8n/workflow-sdk` itself throws plain
 * `SyntaxError` — it defines no error class of this name. So wrapping is not
 * strictly required for the hint to fire today. It is kept deliberately: the
 * name states the intent at the boundary and keeps the contract holding if the
 * SDK ever throws something other than `SyntaxError`. Do not "simplify" this
 * away on the assumption that the SDK supplies the name — it does not.
 */
export class WorkflowCodeParseError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'WorkflowCodeParseError';
	}
}

/**
 * Raised when code parses cleanly but the resulting workflow is invalid
 * (unknown node type, bad connection, schema violation).
 *
 * Deliberately *not* named `WorkflowCodeParseError`: the SDK-reference hint
 * would be misleading here, since the problem is the workflow's content rather
 * than its syntax.
 */
export class WorkflowValidationError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(
			errors.length === 1
				? errors[0]
				: `Workflow validation failed with ${errors.length} errors: ${errors.join('; ')}`,
		);
		this.name = 'WorkflowValidationError';
		this.errors = errors;
	}
}
