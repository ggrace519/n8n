import type { LangchainMessage } from './types';

/**
 * Whether a value is an array of LangChain messages.
 *
 * Guards the boundary where persisted JSON comes back out of the database:
 * `mapStoredMessagesToChatMessages` is typed as returning messages, but the
 * column it was fed could hold anything written by an older schema or a
 * hand-edited row. Callers fall back to an empty history when this is false,
 * so a corrupt row costs the conversation rather than crashing the request.
 *
 * Duck-typed on a callable `_getType` instead of `instanceof BaseMessage`: the
 * concrete classes vary by message role, and an `instanceof` check would also
 * fail across duplicate copies of `@langchain/core` in the dependency tree.
 */
export function isLangchainMessagesArray(value: unknown): value is LangchainMessage[] {
	if (!Array.isArray(value)) return false;

	return value.every(
		(item: unknown) =>
			typeof item === 'object' &&
			item !== null &&
			'_getType' in item &&
			typeof (item as { _getType: unknown })._getType === 'function',
	);
}
