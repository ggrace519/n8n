import type { ValidationWarning } from '@n8n/workflow-sdk';

/**
 * Identity of a validation warning, used to tell pre-existing warnings from
 * ones a given edit introduced.
 *
 * Keyed on code + node + parameter path rather than the message, so rewording a
 * warning doesn't make it look new. Two warnings of the same code on the same
 * parameter of the same node are the same warning.
 */
export function getWarningKey(
	warning: Pick<ValidationWarning, 'code' | 'nodeName' | 'parameterPath'>,
): string {
	return `${warning.code}|${warning.nodeName ?? ''}|${warning.parameterPath ?? ''}`;
}
