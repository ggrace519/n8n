import { OperationalError } from 'n8n-workflow';

const MESSAGE =
	'The AI Workflow Builder is not available in this build of n8n. ' +
	'Workflows can still be built by hand, and the workflow-builder MCP tools ' +
	'(node search, SDK reference, validation) are fully functional.';

/**
 * Raised by every {@link AiWorkflowBuilderService} operation that would need the
 * LLM agent, which this fair-code build does not ship.
 *
 * Deliberately an error rather than an empty success. A method here that
 * returned `{ messages: [] }` or `{ creditsQuota: 0 }` would let a caller
 * believe the builder ran and produced nothing — indistinguishable from a
 * genuine no-op, and the exact failure shape that let a permissions constant
 * satisfy a check earlier in this de-fork while production took another path.
 *
 * `OperationalError` because this is neither a code defect nor the caller's
 * mistake: it is a known, expected gap that should be reported and handled, not
 * alerted on. `/ai/build` already re-emits the message into its response stream,
 * so the editor surfaces this text directly.
 */
export class AiBuilderUnavailableError extends OperationalError {
	constructor(operation: string) {
		super(`${MESSAGE} (requested: ${operation})`);
	}
}
