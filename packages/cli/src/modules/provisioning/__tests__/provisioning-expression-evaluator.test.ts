import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';

import { MAX_CLAIMS_DEPTH } from '../constants';
import {
	ProvisioningExpressionError,
	ProvisioningExpressionEvaluator,
} from '../provisioning-expression-evaluator';
import type { ProvisioningExpressionContext } from '../types';

/**
 * Drives the real isolate. IdP claims are untrusted input, so the point of
 * these cases is that every way a rule can misbehave ends as a
 * `ProvisioningExpressionError` — the caller's fail-closed signal — and that no
 * claim value ever reaches the error.
 */
describe('ProvisioningExpressionEvaluator', () => {
	const evaluator = new ProvisioningExpressionEvaluator(mock<Logger>());

	const samlContext = (claims: Record<string, unknown>): ProvisioningExpressionContext => ({
		$claims: claims,
		$provider: 'saml',
	});

	afterAll(async () => {
		await evaluator.shutdown();
	});

	const failureOf = async (
		expression: string,
		claims: Record<string, unknown> = {},
	): Promise<ProvisioningExpressionError> => {
		try {
			await evaluator.evaluate('rule-1', expression, samlContext(claims));
		} catch (error) {
			if (error instanceof ProvisioningExpressionError) return error;
			throw error;
		}
		throw new Error('expected the evaluation to fail');
	};

	describe('matching', () => {
		it('resolves a matching claim comparison to true', async () => {
			const result = await evaluator.evaluate(
				'rule-1',
				"{{ $claims.department === 'it' }}",
				samlContext({ department: 'it' }),
			);

			expect(result).toBe(true);
		});

		it('resolves a non-matching claim comparison to false', async () => {
			const result = await evaluator.evaluate(
				'rule-1',
				"{{ $claims.department === 'it' }}",
				samlContext({ department: 'sales' }),
			);

			expect(result).toBe(false);
		});

		it('supports array membership over a claim', async () => {
			const result = await evaluator.evaluate(
				'rule-1',
				"{{ $claims.groups !== undefined && $claims.groups.includes('n8n-editors') }}",
				samlContext({ groups: ['n8n-editors', 'devops'] }),
			);

			expect(result).toBe(true);
		});

		it('exposes the provider discriminator', async () => {
			const result = await evaluator.evaluate(
				'rule-1',
				"{{ $provider === 'saml' }}",
				samlContext({}),
			);

			expect(result).toBe(true);
		});

		it('exposes both OIDC claim documents', async () => {
			const result = await evaluator.evaluate('rule-1', '{{ $oidc.userInfo.tier === 1 }}', {
				$claims: { tier: 1 },
				$provider: 'oidc',
				$oidc: { idToken: {}, userInfo: { tier: 1 } },
			});

			expect(result).toBe(true);
		});
	});

	describe('fail-closed outcomes', () => {
		it('fails when the expression exceeds its time budget', async () => {
			const error = await failureOf('{{ (() => { while (true) {} })() }}');

			expect(error.failure).toBe('timeout');
		});

		it('fails when the expression exceeds its memory budget', async () => {
			const error = await failureOf(
				'{{ (() => { const held = []; while (true) held.push(new Array(100000).fill("x")); })() }}',
			);

			expect(error.failure).toBe('memory_limit');
		});

		// External (backing-store) allocations are not charged to the isolate heap
		// the same way, so this path lands on the result check instead — still closed.
		it('fails when a rule allocates an oversized typed array', async () => {
			const error = await failureOf(
				'{{ (() => { const b = new Uint8Array(64 * 1024 * 1024); return b.length > 0; })() }}',
			);

			expect(error).toBeInstanceOf(ProvisioningExpressionError);
		});

		it('fails when a rule reaches for the prototype chain', async () => {
			const error = await failureOf("{{ $claims.constructor.constructor('return 1')() }}");

			expect(error.failure).not.toBe('non_boolean_result');
			expect(error).toBeInstanceOf(ProvisioningExpressionError);
		});

		it('fails when the expression is not valid', async () => {
			const error = await failureOf('{{ this is not an expression }}');

			expect(error).toBeInstanceOf(ProvisioningExpressionError);
		});

		it('fails when the result is not a boolean', async () => {
			const error = await failureOf('{{ $claims.department }}', { department: 'it' });

			expect(error.failure).toBe('non_boolean_result');
		});

		it('fails before the isolate is reached when the claims are oversized', async () => {
			const error = await failureOf('{{ true }}', { blob: 'x'.repeat(200 * 1024) });

			expect(error.failure).toBe('claims_too_large');
		});

		it('fails before the isolate is reached when the claims are too deeply nested', async () => {
			let nested: Record<string, unknown> = {};
			for (let depth = 0; depth <= MAX_CLAIMS_DEPTH + 1; depth++) nested = { nested };

			const error = await failureOf('{{ true }}', nested);

			expect(error.failure).toBe('claims_too_deep');
		});

		it('fails when the claims cannot be serialized at all', async () => {
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;

			const error = await failureOf('{{ true }}', cyclic);

			expect(error.failure).toBe('claims_too_large');
		});
	});

	it('never puts claim values into the error it raises', async () => {
		const secret = 'super-secret-claim-value';

		const error = await failureOf('{{ $claims.department }}', {
			department: secret,
			groups: [secret],
		});

		expect(error.message).not.toContain(secret);
		expect(error.message).toContain('rule-1');
		expect(JSON.stringify(error)).not.toContain(secret);
	});
});
