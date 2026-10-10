import type { GlobalConfig } from '@n8n/config';
import { LICENSE_QUOTAS } from '@n8n/constants';

import type { License } from '@/license';

/** Evaluation concurrency per plan when neither the env nor the license sets one. */
const EVALUATION_CONCURRENCY_BY_PLAN: Readonly<Record<string, number>> = {
	Community: 1,
	Business: 3,
	Enterprise: 5,
};

/**
 * The evaluation-execution concurrency cap: an explicitly set
 * `N8N_CONCURRENCY_EVALUATION_LIMIT` wins, including `-1` for unlimited; then a
 * license-issued quota; then the plan default (this fork reports `Community`,
 * i.e. one evaluation at a time). An unrecognised plan gets the most
 * conservative default. Never 0.
 */
export function resolveEvaluationConcurrencyLimit(
	executions: GlobalConfig['executions'],
	license: License,
): number {
	// The config value alone can't tell "unset" from an explicit -1 (both are -1),
	// and only an explicit setting should override the license and plan defaults.
	if (process.env.N8N_CONCURRENCY_EVALUATION_LIMIT !== undefined) {
		const envLimit = executions.concurrency.evaluationLimit;
		return envLimit > 0 ? envLimit : -1;
	}

	const licensedLimit = license.getValue(LICENSE_QUOTAS.EVALUATION_CONCURRENCY_LIMIT);
	if (typeof licensedLimit === 'number' && licensedLimit > 0) return licensedLimit;

	return (
		EVALUATION_CONCURRENCY_BY_PLAN[license.getPlanName()] ??
		EVALUATION_CONCURRENCY_BY_PLAN.Community
	);
}
