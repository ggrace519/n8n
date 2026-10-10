import { DecideWorkflowReviewRequestDto } from '../decide-workflow-review-request.dto';

describe('DecideWorkflowReviewRequestDto', () => {
	describe('Valid requests', () => {
		test.each([
			{
				name: 'approval naming the inspected version',
				request: { decision: 'approved', expectedVersionId: 'aBcDeFgHiJkLmNoP' },
			},
			{
				name: 'change request naming the inspected version',
				request: { decision: 'changes_requested', expectedVersionId: 'aBcDeFgHiJkLmNoP' },
			},
			{
				name: 'decision on a request with no pinned version',
				request: { decision: 'approved', expectedVersionId: null },
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
				request: { expectedVersionId: 'aBcDeFgHiJkLmNoP' },
				expectedErrorPath: ['decision'],
			},
			{
				// Omitting it would opt out of the re-pin check entirely.
				name: 'missing expectedVersionId',
				request: { decision: 'approved' },
				expectedErrorPath: ['expectedVersionId'],
			},
			{
				name: 'pending decision',
				request: { decision: 'pending', expectedVersionId: null },
				expectedErrorPath: ['decision'],
			},
			{
				name: 'unknown decision',
				request: { decision: 'rejected', expectedVersionId: null },
				expectedErrorPath: ['decision'],
			},
			{
				name: 'non-string decision',
				request: { decision: 1, expectedVersionId: null },
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
