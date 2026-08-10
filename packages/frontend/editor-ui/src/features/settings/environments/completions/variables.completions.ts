import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { useI18n } from '@n8n/i18n';

import { useEnvironmentsStore } from '../environments.store';

/** Tag a completion as a variable so it renders with the variable icon/type. */
export const addVarType = (option: Completion): Completion => ({ ...option, type: 'variable' });

const escape = (str: string) => str.replace('$', '\\$');

export function useVariablesCompletions() {
	const i18n = useI18n();

	/**
	 * Complete `$vars.` with the keys of the variables available in the current
	 * scope (global + current project).
	 */
	const variablesCompletions = (
		context: CompletionContext,
		matcher = '$vars',
	): CompletionResult | null => {
		const pattern = new RegExp(`${escape(matcher)}\..*`);

		const preCursor = context.matchBefore(pattern);

		if (!preCursor || (preCursor.from === preCursor.to && !context.explicit)) return null;

		const environmentsStore = useEnvironmentsStore();

		const options: Completion[] = Object.keys(environmentsStore.variablesAsObject)
			.sort((a, b) => a.localeCompare(b))
			.map((key) => ({
				label: `${matcher}.${key}`,
				info: i18n.baseText('codeNodeEditor.completer.$vars.varName.global'),
			}));

		return {
			from: preCursor.from,
			options: options.map(addVarType),
		};
	};

	return { variablesCompletions };
}
