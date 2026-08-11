import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { isLangchainMessagesArray } from '../guards';

describe('isLangchainMessagesArray', () => {
	it('accepts an array of real LangChain messages', () => {
		expect(isLangchainMessagesArray([new HumanMessage('hi'), new AIMessage('hello')])).toBe(true);
	});

	it('accepts an empty array', () => {
		expect(isLangchainMessagesArray([])).toBe(true);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'not an array'],
		['an object', { messages: [] }],
	])('rejects %s', (_label, value) => {
		expect(isLangchainMessagesArray(value)).toBe(false);
	});

	/**
	 * The realistic corruption: a row written by an older schema comes back as
	 * plain JSON. It must not be mistaken for live messages, or every read of
	 * that conversation throws deep inside the agent instead of falling back.
	 */
	it('rejects plain objects that merely look like messages', () => {
		expect(isLangchainMessagesArray([{ type: 'human', content: 'hi' }])).toBe(false);
	});

	it('rejects an array where only some entries are messages', () => {
		expect(isLangchainMessagesArray([new HumanMessage('hi'), { content: 'hi' }])).toBe(false);
	});

	it('rejects entries whose _getType is not callable', () => {
		expect(isLangchainMessagesArray([{ _getType: 'human' }])).toBe(false);
	});
});
