import type {
	AiInsightsPayload,
	AiInsightsRegression,
	AiInsightsResponse,
	EvaluationCollectionRunSummary,
	GenerateInsightsPayload,
} from '@n8n/api-types';
import { aiInsightsResponseSchema, normalizedScores } from '@n8n/api-types';
import type { EvaluationCollection } from '@n8n/db';
import { EvaluationCollectionRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EvaluationCollectionsService } from '@/evaluation/evaluation-collections.service';

// Mirror the schema's string caps (`eval-insights.schema.ts`); every generated
// string is clamped so the `.strict()` parse of the envelope can't fail on
// length. Labels ("V1", …) stay far below the schema's 8-char cap by design.
const HEADLINE_MAX = 120;
const BODY_MAX = 280;
const METRIC_MAX = 120;

/** A version regresses on a metric when it trails the winner by ≥5 points. */
const REGRESSION_THRESHOLD_POINTS = 5;

type VersionAggregate = {
	label: string;
	avgScore: number;
	/** Per-metric scores normalized to [0, 1] on the run's own scales. */
	scores: Record<string, number>;
};

function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function roundPoints(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * AI insights for an evaluation collection: winner, regressions, and a
 * suggested next experiment, cached on the collection row.
 *
 * Only the deterministic generation path (`status: 'fallback'`) is
 * implemented: the LLM used elsewhere in the product lives inside the
 * conditionally-loaded `instance-ai` backend module, which core evaluation
 * code must not depend on, and no injectable model seam exists outside it.
 * `fallback` is a first-class documented state of the response schema.
 */
@Service()
export class EvalInsightsService {
	constructor(
		private readonly evaluationCollectionRepository: EvaluationCollectionRepository,
		private readonly evaluationCollectionsService: EvaluationCollectionsService,
	) {}

	/** The cached envelope, or null when none (or a stale shape) is stored. */
	async getCached(workflowId: string, collectionId: string): Promise<AiInsightsResponse | null> {
		const collection = await this.assertCollection(workflowId, collectionId);
		return this.parseCache(collection.insightsCache);
	}

	/**
	 * Return the cached envelope when fresh and not forced; otherwise generate,
	 * store, and return a new one.
	 */
	async generate(
		workflowId: string,
		collectionId: string,
		payload: GenerateInsightsPayload,
	): Promise<AiInsightsResponse> {
		const collection = await this.assertCollection(workflowId, collectionId);

		if (!payload.forceRegenerate) {
			const cached = this.parseCache(collection.insightsCache);
			if (cached) return cached;
		}

		const detail = await this.evaluationCollectionsService.getDetail(workflowId, collectionId);
		const envelope = aiInsightsResponseSchema.parse({
			generatedAt: new Date().toISOString(),
			modelUsed: 'deterministic',
			status: 'fallback',
			insights: this.buildDeterministicInsights(detail.runs),
		});

		// Serialized round-trip: the cache column stores plain JSON.
		await this.evaluationCollectionRepository.updateInsightsCache(
			collectionId,
			jsonParse<IDataObject>(JSON.stringify(envelope)),
		);
		return envelope;
	}

	/**
	 * Deterministic insights from per-version aggregates: the winner is the
	 * highest-avgScore version, regressions are metrics trailing the winner by
	 * ≥5 points, and the suggestion targets the biggest regression.
	 */
	buildDeterministicInsights(runs: EvaluationCollectionRunSummary[]): AiInsightsPayload {
		// Labels follow run order over ALL runs (V1 = oldest), so a version keeps
		// its label even when other runs are unscored.
		const versions: VersionAggregate[] = [];
		runs.forEach((run, index) => {
			if (run.avgScore === null) return;
			versions.push({
				label: `V${index + 1}`,
				avgScore: run.avgScore,
				scores: normalizedScores(run.metrics, run.metricScales),
			});
		});
		if (versions.length === 0) {
			throw new BadRequestError(
				'The collection has no scored runs yet, so no insights can be generated',
			);
		}

		const winner = versions.reduce((best, version) =>
			version.avgScore > best.avgScore ? version : best,
		);
		const pct = (score: number) => Math.round(score * 100);

		const regressions: AiInsightsRegression[] = [];
		for (const version of versions) {
			if (version === winner) continue;
			for (const [metric, winnerScore] of Object.entries(winner.scores)) {
				const versionScore = version.scores[metric];
				if (versionScore === undefined) continue;
				const deltaPoints = (versionScore - winnerScore) * 100;
				if (deltaPoints > -REGRESSION_THRESHOLD_POINTS) continue;
				const delta = roundPoints(deltaPoints);
				regressions.push({
					versionLabel: version.label,
					metric: clamp(metric, METRIC_MAX),
					delta,
					headline: clamp(`${metric} regresses on ${version.label}`, HEADLINE_MAX),
					body: clamp(
						`${version.label} scores ${pct(versionScore)}% on ${metric}, ${Math.abs(delta)} points below ${winner.label} (${pct(winnerScore)}%).`,
						BODY_MAX,
					),
				});
			}
		}
		// Biggest regression first (most negative delta).
		regressions.sort((a, b) => a.delta - b.delta);

		const worst = regressions[0];
		const suggestedNext = worst
			? {
					headline: clamp(`Close the ${worst.metric} gap`, HEADLINE_MAX),
					body: clamp(
						`${worst.versionLabel} trails ${winner.label} most on ${worst.metric}. Focus the next iteration there.`,
						BODY_MAX,
					),
					hypothesis: clamp(
						`Changing the workflow steps behind ${worst.metric} on ${worst.versionLabel} closes most of the ${Math.abs(worst.delta)}-point gap to ${winner.label}.`,
						BODY_MAX,
					),
				}
			: {
					headline: 'Extend the experiment',
					body: clamp(
						`No metric on any version trails ${winner.label} by ${REGRESSION_THRESHOLD_POINTS}+ points. Compare a bolder variation next.`,
						BODY_MAX,
					),
					hypothesis: clamp(
						`A larger change to the workflow would separate the versions more than the current ${versions.length}-way comparison does.`,
						BODY_MAX,
					),
				};

		return {
			winner: {
				versionLabel: winner.label,
				headline: clamp(`${winner.label} leads at ${pct(winner.avgScore)}%`, HEADLINE_MAX),
				body: clamp(
					`${winner.label} has the highest average score (${pct(winner.avgScore)}%) across ${Object.keys(winner.scores).length} metric(s) and ${versions.length} scored version(s).`,
					BODY_MAX,
				),
			},
			regressions,
			suggestedNext,
		};
	}

	private async assertCollection(
		workflowId: string,
		collectionId: string,
	): Promise<EvaluationCollection> {
		const collection = await this.evaluationCollectionRepository.findOneInWorkflow(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Evaluation collection not found');
		return collection;
	}

	/**
	 * Strict parse of the stored cache: an older envelope that no longer
	 * matches the schema reads as "no cache" and regenerates rather than
	 * surfacing stale or partial fields.
	 */
	private parseCache(cache: EvaluationCollection['insightsCache']): AiInsightsResponse | null {
		if (!cache) return null;
		const parsed = aiInsightsResponseSchema.safeParse(cache);
		return parsed.success ? parsed.data : null;
	}
}
