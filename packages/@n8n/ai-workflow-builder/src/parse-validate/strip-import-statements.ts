/**
 * Remove ES import statements from workflow SDK code before interpretation.
 *
 * Generated code carries a leading `import { workflow } from '@n8n/workflow-sdk'`
 * (and occasionally side-effect imports) for editor ergonomics, but the AST
 * interpreter resolves SDK builders from an injected scope, not from imports.
 * Stripping is idempotent, so it is safe to call on already-stripped code.
 */
export function stripImportStatements(code: string): string {
	return (
		code
			// `import ... from '...'` (single- or multi-line binding lists)
			.replace(/import\b[\s\S]*?from\s*['"][^'"]*['"]\s*;?/g, '')
			// side-effect imports: `import '...'`
			.replace(/import\s*['"][^'"]*['"]\s*;?/g, '')
			// collapse the blank lines the removals leave at the top of the file
			.replace(/^\s*\n/gm, '')
			.trimStart()
	);
}
