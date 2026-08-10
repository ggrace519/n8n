import { n8nIdSchema } from '../../schemas/id.schema';
import { workflowReviewRequestDecisionSchema } from '../../workflow-review-request-summary';
import { Z } from '../../zod-class';

export class DecideWorkflowReviewRequestDto extends Z.class({
	decision: workflowReviewRequestDecisionSchema.exclude(['pending']),
	/**
	 * The version the reviewer inspected. When sent, the decision is rejected
	 * with a conflict if the author re-pinned the request in the meantime, so an
	 * unreviewed version can never be approved. Optional for compatibility with
	 * clients that do not send it yet — those remain protected only against a
	 * re-pin racing the decision, not against one that landed before it.
	 */
	expectedVersionId: n8nIdSchema.optional(),
}) {}
