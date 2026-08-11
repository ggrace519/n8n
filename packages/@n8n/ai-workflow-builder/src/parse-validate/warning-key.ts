import type { ValidationWarning } from './types';

/**
 * Location-based identity for a validation warning: `code|nodeName|parameterPath`.
 *
 * Keyed on where the warning is, not its wording, so a reworded message for the
 * same node/parameter still matches (used to diff pre- vs post-update warnings
 * and mark carried-over ones as pre-existing). A renamed node intentionally
 * misses, since the rename is a change to that node.
 */
export function getWarningKey(warning: ValidationWarning): string {
	return `${warning.code}|${warning.nodeName ?? ''}|${warning.parameterPath ?? ''}`;
}
