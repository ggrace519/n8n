import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { classifyExpressionError, type ExpressionEvaluator } from '@n8n/expression-runtime';
import { OperationalError } from 'n8n-workflow';

import {
	MAX_CLAIMS_DEPTH,
	MAX_CLAIMS_SERIALIZED_BYTES,
	RULE_EXPRESSION_MEMORY_LIMIT_MB,
	RULE_EXPRESSION_TIMEOUT_MS,
} from './constants';
import type { ProvisioningExpressionContext } from './types';

/** Why a rule could not be decided. Never carries claim data. */
export type ProvisioningExpressionFailure =
	| 'timeout'
	| 'memory_limit'
	| 'security'
	| 'syntax'
	| 'claims_too_large'
	| 'claims_too_deep'
	| 'non_boolean_result'
	| 'unknown';

/**
 * A mapping rule could not be evaluated. The message deliberately carries only
 * the rule id and a failure class — claims and claim values are attacker
 * -influenced and must not reach logs, audit records, or HTTP responses.
 */
export class ProvisioningExpressionError extends OperationalError {
	constructor(
		readonly ruleId: string,
		readonly failure: ProvisioningExpressionFailure,
	) {
		super(`Role mapping rule ${ruleId} could not be evaluated (${failure})`);
	}
}

/**
 * Evaluates role-mapping expressions in a V8 isolate.
 *
 * Operators author the expressions, but the claims they read are supplied by
 * the IdP and are treated as untrusted. The isolate therefore sees a
 * structured clone of the claims and the provider discriminator and nothing
 * else — no host functions, no `process`, no filesystem or network reach — and
 * a rule that cannot produce a boolean within its budget is a failure, not a
 * "no match".
 */
@Service()
export class ProvisioningExpressionEvaluator {
	private evaluator: ExpressionEvaluator | null = null;

	private starting: Promise<ExpressionEvaluator> | null = null;

	constructor(private readonly logger: Logger) {}

	/**
	 * Evaluates one rule. Resolves to the boolean the rule produced; throws
	 * {@link ProvisioningExpressionError} for every other outcome so callers can
	 * fail the login closed.
	 */
	async evaluate(
		ruleId: string,
		expression: string,
		context: ProvisioningExpressionContext,
	): Promise<boolean> {
		const data = this.toIsolateData(ruleId, context);
		const evaluator = await this.getEvaluator();

		// A caller token scopes the isolate to this single evaluation.
		const caller = {};
		let acquired = false;
		try {
			acquired = await evaluator.acquire(caller);
			const result = evaluator.evaluate(expression, data, caller);
			if (typeof result !== 'boolean') {
				throw new ProvisioningExpressionError(ruleId, 'non_boolean_result');
			}
			return result;
		} catch (error) {
			if (error instanceof ProvisioningExpressionError) throw error;
			throw new ProvisioningExpressionError(ruleId, classifyExpressionError(error));
		} finally {
			if (acquired) {
				try {
					await evaluator.release(caller);
				} catch (error) {
					this.logger.error('Failed to release provisioning expression isolate', { error });
				}
			}
		}
	}

	/** Releases the isolate pool. Safe to call when nothing was started. */
	async shutdown(): Promise<void> {
		const evaluator = this.evaluator ?? (await this.starting?.catch(() => null));
		this.evaluator = null;
		this.starting = null;
		if (evaluator) await evaluator.dispose();
	}

	/**
	 * Copies the claims into a plain, cycle-free structure. Doing this on the
	 * host means the isolate never sees a getter, proxy, or prototype the IdP
	 * could have influenced.
	 */
	private toIsolateData(
		ruleId: string,
		context: ProvisioningExpressionContext,
	): Record<string, unknown> {
		const serialized = safeSerialize(context.$claims);
		if (serialized === null) throw new ProvisioningExpressionError(ruleId, 'claims_too_large');
		if (Buffer.byteLength(serialized, 'utf8') > MAX_CLAIMS_SERIALIZED_BYTES) {
			throw new ProvisioningExpressionError(ruleId, 'claims_too_large');
		}
		if (exceedsDepth(context.$claims, MAX_CLAIMS_DEPTH)) {
			throw new ProvisioningExpressionError(ruleId, 'claims_too_deep');
		}

		const data: Record<string, unknown> = {
			$claims: structuredClone(context.$claims),
			$provider: context.$provider,
		};
		if (context.$oidc) {
			data.$oidc = structuredClone({
				idToken: context.$oidc.idToken,
				userInfo: context.$oidc.userInfo,
			});
		}
		return data;
	}

	private async getEvaluator(): Promise<ExpressionEvaluator> {
		if (this.evaluator) return this.evaluator;
		// Started on first use: an instance with no rules must not pay for an isolate.
		this.starting ??= this.startEvaluator();
		try {
			this.evaluator = await this.starting;
			return this.evaluator;
		} finally {
			this.starting = null;
		}
	}

	private async startEvaluator(): Promise<ExpressionEvaluator> {
		const { ExpressionEvaluator, IsolatedVmBridge } = await import('@n8n/expression-runtime');
		const { ThisSanitizer, PrototypeSanitizer, DollarSignValidator } = await import(
			'n8n-workflow/expression-sandboxing'
		);

		const evaluator = new ExpressionEvaluator({
			createBridge: () =>
				new IsolatedVmBridge({
					timeout: RULE_EXPRESSION_TIMEOUT_MS,
					memoryLimit: RULE_EXPRESSION_MEMORY_LIMIT_MB,
					logger: this.logger,
				}),
			maxCodeCacheSize: 128,
			poolSize: 1,
			hooks: {
				before: [ThisSanitizer],
				after: [PrototypeSanitizer, DollarSignValidator],
			},
			logger: this.logger,
		});
		await evaluator.initialize();
		return evaluator;
	}
}

/** `null` when the value cannot be serialized at all (cycles, BigInt, …). */
function safeSerialize(value: unknown): string | null {
	try {
		return JSON.stringify(value) ?? 'null';
	} catch {
		return null;
	}
}

function exceedsDepth(value: unknown, remaining: number): boolean {
	if (typeof value !== 'object' || value === null) return false;
	if (remaining <= 0) return true;
	for (const nested of Object.values(value)) {
		if (exceedsDepth(nested, remaining - 1)) return true;
	}
	return false;
}
