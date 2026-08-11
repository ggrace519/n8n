import type { LangchainMessage } from './types';

/**
 * Narrow an arbitrary array to LangChain messages. Restored session history
 * comes back as generic stored objects; only entries carrying a `_getType`
 * method are genuine `BaseMessage` instances, so the storage layer can safely
 * treat the array as `LangchainMessage[]`.
 */
export function isLangchainMessagesArray(arr: unknown[]): arr is LangchainMessage[] {
	if (!Array.isArray(arr)) return false;
	return arr.every(
		(item: unknown) =>
			typeof item === 'object' &&
			item !== null &&
			'_getType' in item &&
			typeof (item as { _getType: unknown })._getType === 'function',
	);
}
