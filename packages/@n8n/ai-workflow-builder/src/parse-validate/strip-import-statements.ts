/** Matches `import … from '…'` / `import '…'`, terminated by the quote pair. */
const IMPORT_START = /^\s*import\b/;
const IMPORT_END = /from\s*(['"])[^'"]*\1\s*;?\s*$|^\s*import\s*(['"])[^'"]*\2\s*;?\s*$/;

const isBlankOrComment = (line: string) => {
	const trimmed = line.trim();
	return trimmed === '' || trimmed.startsWith('//');
};

/**
 * Drops the leading import statements from workflow SDK code.
 *
 * Generated code opens with `import { workflow, node, … } from '@n8n/workflow-sdk'`,
 * which the SDK's AST interpreter has no module resolution for. Only the
 * *leading* import block is removed — scanning stops at the first real
 * statement — so an `import` appearing later inside a Code node's template
 * literal is left untouched. A blanket regex over the whole file would corrupt
 * that node's script.
 *
 * Multi-line imports are handled: the scan consumes lines until the one
 * closing the module specifier.
 */
export function stripImportStatements(code: string): string {
	const lines = code.split('\n');
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		if (isBlankOrComment(line)) {
			index++;
			continue;
		}

		if (!IMPORT_START.test(line)) break;

		// Consume the statement, which may wrap across several lines.
		const start = index;
		while (index < lines.length && !IMPORT_END.test(lines[index])) index++;

		// Unterminated import (truncated code): leave it in place rather than
		// swallowing the rest of the file, and let the parser report it.
		if (index >= lines.length) {
			index = start;
			break;
		}

		index++;
	}

	return lines.slice(index).join('\n').trimStart();
}
