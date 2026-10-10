import { n8nIdSchema } from '../../schemas/id.schema';
import { workflowReviewRequestDecisionSchema } from '../../workflow-review-request-summary';
import { Z } from '../../zod-class';

export class DecideWorkflowReviewRequestDto extends Z.class({
	decision: workflowReviewRequestDecisionSchema.exclude(['pending']),
	/**
	 * The version the reviewer inspected (`null` when the request has no pinned
	 * version). Required: the decision is rejected with a conflict if the author
	 * re-pinned the request in the meantime, so an unreviewed version can never be
	 * approved -- whether the re-pin raced the decision or landed before it.
	 */
	expectedVersionId: n8nIdSchema.nullable(),
}) {}
