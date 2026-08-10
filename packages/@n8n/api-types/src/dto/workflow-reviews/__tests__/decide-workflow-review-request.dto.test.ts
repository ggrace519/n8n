import { DecideWorkflowReviewRequestDto } from '../decide-workflow-review-request.dto';

describe('DecideWorkflowReviewRequestDto', () => {
	describe('Valid requests', () => {
		test.each([
			{ name: 'approved decision', request: { decision: 'approved' } },
			{ name: 'changes_requested decision', request: { decision: 'changes_requested' } },
			{
				name: 'decision naming the inspected version',
				request: { decision: 'approved', expectedVersionId: 'aBcDeFgHiJkLmNoP' },
			},
		])('should validate $name', ({ request }) => {
			const result = DecideWorkflowReviewRequestDto.safeParse(request);
			expect(result.success).toBe(true);
			expect(result.data).toMatchObject(request);
		});
	});

	describe('Invalid requests', () => {
		test.each([
			{
				name: 'missing decision',
				request: {},
				expectedErrorPath: ['decision'],
			},
			{
				name: 'pending decision',
				request: { decision: 'pending' },
				expectedErrorPath: ['decision'],
			},
			{
				name: 'unknown decision',
				request: { decision: 'rejected' },
				expectedErrorPath: ['decision'],
			},
			{
				name: 'non-string decision',
				request: { decision: 1 },
				expectedErrorPath: ['decision'],
			},
			{
				name: 'over-long expectedVersionId',
				request: { decision: 'approved', expectedVersionId: 'x'.repeat(37) },
				expectedErrorPath: ['expectedVersionId'],
			},
		])('should fail validation for $name', ({ request, expectedErrorPath }) => {
			const result = DecideWorkflowReviewRequestDto.safeParse(request);
			expect(result.success).toBe(false);
			expect(result.error?.issues[0].path).toEqual(expectedErrorPath);
		});
	});
});
