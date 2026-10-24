import type { ContextEstablishmentOptions } from '@n8n/decorators';
import type { INode } from 'n8n-workflow';

import { BearerTokenExtractor } from '../bearer-token-extractor.hook';

const optionsWith = (headers: Record<string, unknown>) =>
	({
		triggerNode: { type: 'n8n-nodes-base.webhook' } as INode,
		triggerItems: [{ json: { headers, body: { ok: true } } }],
		context: {},
	}) as unknown as ContextEstablishmentOptions;

describe('BearerTokenExtractor', () => {
	const hook = new BearerTokenExtractor();

	it('makes the Bearer the external identity and strips it from the trigger item', async () => {
		const result = await hook.execute(
			optionsWith({ authorization: 'Bearer abc.def', 'x-request-id': '1' }),
		);

		expect(result.contextUpdate?.credentials).toEqual({
			version: 1,
			identity: 'Bearer abc.def',
			metadata: { source: 'external' },
		});
		expect(result.triggerItems?.[0].json).toEqual({
			headers: { 'x-request-id': '1' },
			body: { ok: true },
		});
	});

	it('fails the run when no Bearer is sent', async () => {
		await expect(hook.execute(optionsWith({}))).rejects.toThrow('Authorization: Bearer');
		await expect(hook.execute(optionsWith({ authorization: 'Basic x' }))).rejects.toThrow();
	});

	it('is offered only on the Webhook trigger', () => {
		expect(hook.isApplicableToTriggerNode('n8n-nodes-base.webhook')).toBe(true);
		expect(hook.isApplicableToTriggerNode('n8n-nodes-base.scheduleTrigger')).toBe(false);
	});
});
