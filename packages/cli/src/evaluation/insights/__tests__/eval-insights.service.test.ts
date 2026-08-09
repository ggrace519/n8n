import type { AiInsightsResponse, EvaluationCollectionRunSummary } from '@n8n/api-types';
import { aiInsightsResponseSchema } from '@n8n/api-types';
import type { EvaluationCollection, EvaluationCollectionRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import type { EvaluationCollectionsService } from '@/evaluation/evaluation-collections.service';
import { EvalInsightsService } from '@/evaluation/insights/eval-insights.service';

function runSummary(
	overrides: Partial<EvaluationCollectionRunSummary> = {},
): EvaluationCollectionRunSummary {
	return {
		testRunId: 'run-1',
		workflowVersionId: null,
		status: 'completed',
		runAt: null,
		completedAt: null,
		avgScore: null,
		metrics: null,
		metricScales: {},
		...overrides,
	};
}

function validEnvelope(): AiInsightsResponse {
	return {
		generatedAt: '2026-01-01T00:00:00.000Z',
		modelUsed: 'deterministic',
		status: 'fallback',
		insights: {
			winner: { versionLabel: 'V1', headline: 'V1 wins', body: 'Cached winner.' },
			regressions: [],
			suggestedNext: { headline: 'Next', body: 'Cached body.', hypothesis: 'Cached hypothesis.' },
		},
	};
}

describe('EvalInsightsService', () => {
	const collectionRepository = mock<EvaluationCollectionRepository>();
	const collectionsService = mock<EvaluationCollectionsService>();
	const service = new EvalInsightsService(collectionRepository, collectionsService);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('buildDeterministicInsights', () => {
		it('should pick the highest-avgScore version as winner, labeled by run order', () => {
			const insights = service.buildDeterministicInsights([
				runSummary({
					testRunId: 'run-a',
					avgScore: 0.6,
					metrics: { quality: 0.6 },
					metricScales: { quality: 'unit' },
				}),
				runSummary({
					testRunId: 'run-b',
					avgScore: 0.9,
					metrics: { quality: 0.9 },
					metricScales: { quality: 'unit' },
				}),
			]);

			expect(insights.winner.versionLabel).toBe('V2');
			expect(insights.winner.headline).toContain('V2');
		});

		it('should keep labels stable when earlier runs are unscored', () => {
			const insights = service.buildDeterministicInsights([
				runSummary({ testRunId: 'run-a', avgScore: null }),
				runSummary({
					testRunId: 'run-b',
					avgScore: 0.5,
					metrics: { quality: 0.5 },
					metricScales: { quality: 'unit' },
				}),
				runSummary({
					testRunId: 'run-c',
					avgScore: 0.8,
					metrics: { quality: 0.8 },
					metricScales: { quality: 'unit' },
				}),
			]);

			// The unscored run keeps its slot: the winner is V3, not V2.
			expect(insights.winner.versionLabel).toBe('V3');
		});

		it('should report metrics >=5 points below the winner as regressions and skip smaller gaps', () => {
			const insights = service.buildDeterministicInsights([
				runSummary({
					testRunId: 'run-a',
					avgScore: 0.735,
					metrics: { quality: 0.87, accuracy: 0.6 },
					metricScales: { quality: 'unit', accuracy: 'unit' },
				}),
				runSummary({
					testRunId: 'run-b',
					avgScore: 0.85,
					metrics: { quality: 0.9, accuracy: 0.8 },
					metricScales: { quality: 'unit', accuracy: 'unit' },
				}),
			]);

			// quality trails by 3 points (excluded); accuracy by 20 (included).
			expect(insights.regressions).toHaveLength(1);
			expect(insights.regressions[0]).toMatchObject({
				versionLabel: 'V1',
				metric: 'accuracy',
				delta: -20,
			});
			expect(insights.suggestedNext.headline).toContain('accuracy');
		});

		it('should suggest extending the experiment when nothing regresses', () => {
			const insights = service.buildDeterministicInsights([
				runSummary({
					testRunId: 'run-a',
					avgScore: 0.88,
					metrics: { quality: 0.88 },
					metricScales: { quality: 'unit' },
				}),
				runSummary({
					testRunId: 'run-b',
					avgScore: 0.9,
					metrics: { quality: 0.9 },
					metricScales: { quality: 'unit' },
				}),
			]);

			expect(insights.regressions).toHaveLength(0);
			expect(insights.suggestedNext.headline).toBe('Extend the experiment');
		});

		it('should clamp long metric names within the schema caps and produce a valid envelope', () => {
			const longMetric = 'm'.repeat(200);
			const insights = service.buildDeterministicInsights([
				runSummary({
					testRunId: 'run-a',
					avgScore: 0.5,
					metrics: { [longMetric]: 0.5 },
					metricScales: { [longMetric]: 'unit' },
				}),
				runSummary({
					testRunId: 'run-b',
					avgScore: 0.9,
					metrics: { [longMetric]: 0.9 },
					metricScales: { [longMetric]: 'unit' },
				}),
			]);

			expect(insights.regressions[0].metric.length).toBeLessThanOrEqual(120);
			expect(insights.regressions[0].headline.length).toBeLessThanOrEqual(120);
			expect(insights.regressions[0].body.length).toBeLessThanOrEqual(280);
			expect(insights.suggestedNext.headline.length).toBeLessThanOrEqual(120);
			expect(insights.suggestedNext.body.length).toBeLessThanOrEqual(280);
			expect(insights.suggestedNext.hypothesis.length).toBeLessThanOrEqual(280);

			const envelope = aiInsightsResponseSchema.safeParse({
				generatedAt: new Date().toISOString(),
				modelUsed: 'deterministic',
				status: 'fallback',
				insights,
			});
			expect(envelope.success).toBe(true);
		});

		it('should throw a BadRequestError when no run is scored', () => {
			expect(() =>
				service.buildDeterministicInsights([runSummary({ avgScore: null })]),
			).toThrowError(BadRequestError);
		});
	});

	describe('generate', () => {
		it('should return the valid cached envelope without regenerating', async () => {
			const cached = validEnvelope();
			collectionRepository.findOneInWorkflow.mockResolvedValue({
				insightsCache: cached,
			} as unknown as EvaluationCollection);

			const result = await service.generate('wf-1', 'col-1', {});

			expect(result).toEqual(cached);
			expect(collectionsService.getDetail).not.toHaveBeenCalled();
			expect(collectionRepository.updateInsightsCache).not.toHaveBeenCalled();
		});

		it('should regenerate and store when forceRegenerate is set', async () => {
			collectionRepository.findOneInWorkflow.mockResolvedValue({
				insightsCache: validEnvelope(),
			} as unknown as EvaluationCollection);
			collectionsService.getDetail.mockResolvedValue({
				id: 'col-1',
				name: 'c',
				description: null,
				workflowId: 'wf-1',
				evaluationConfigId: 'cfg-1',
				createdById: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				runCount: 1,
				runs: [
					runSummary({
						avgScore: 0.9,
						metrics: { quality: 0.9 },
						metricScales: { quality: 'unit' },
					}),
				],
			});

			const result = await service.generate('wf-1', 'col-1', { forceRegenerate: true });

			expect(result.status).toBe('fallback');
			expect(result.modelUsed).toBe('deterministic');
			expect(result.insights.winner.versionLabel).toBe('V1');
			expect(collectionRepository.updateInsightsCache).toHaveBeenCalledWith(
				'col-1',
				expect.objectContaining({ status: 'fallback' }),
			);
		});
	});

	describe('getCached', () => {
		it('should return null when nothing is cached', async () => {
			collectionRepository.findOneInWorkflow.mockResolvedValue({
				insightsCache: null,
			} as unknown as EvaluationCollection);

			await expect(service.getCached('wf-1', 'col-1')).resolves.toBeNull();
		});

		it('should treat a cache that fails the strict schema as absent', async () => {
			collectionRepository.findOneInWorkflow.mockResolvedValue({
				insightsCache: { some: 'legacy-shape' },
			} as unknown as EvaluationCollection);

			await expect(service.getCached('wf-1', 'col-1')).resolves.toBeNull();
		});
	});
});
