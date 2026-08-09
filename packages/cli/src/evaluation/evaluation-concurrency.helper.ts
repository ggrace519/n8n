import type { GlobalConfig } from '@n8n/config';
import { LICENSE_QUOTAS } from '@n8n/constants';

import type { License } from '@/license';

/**
 * The evaluation-execution concurrency cap: an explicit
 * `N8N_CONCURRENCY_EVALUATION_LIMIT` (> 0) wins; otherwise the license-tier
 * quota applies; otherwise unlimited (-1). Never returns 0.
 */
export function resolveEvaluationConcurrencyLimit(
	executions: GlobalConfig['executions'],
	license: License,
): number {
	const envLimit = executions.concurrency.evaluationLimit;
	if (envLimit > 0) return envLimit;

	const licensedLimit = license.getValue(LICENSE_QUOTAS.EVALUATION_CONCURRENCY_LIMIT);
	if (typeof licensedLimit === 'number' && licensedLimit > 0) return licensedLimit;

	return -1;
}
