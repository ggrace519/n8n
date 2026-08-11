import { SDK_IMPORT_STATEMENT } from '../../tools/sdk-import-statement';
import { stripImportStatements } from '../strip-import-statements';

describe('stripImportStatements', () => {
	it('removes the canonical SDK import', () => {
		const code = `${SDK_IMPORT_STATEMENT}\nexport default workflow('id', 'Name');`;
		expect(stripImportStatements(code)).toBe("export default workflow('id', 'Name');");
	});

	it('removes a multi-line import', () => {
		const code = [
			'import {',
			'  workflow,',
			'  trigger,',
			"} from '@n8n/workflow-sdk';",
			"export default workflow('id', 'Name');",
		].join('\n');
		expect(stripImportStatements(code)).toBe("export default workflow('id', 'Name');");
	});

	it('removes several imports, plus the blank lines and comments between them', () => {
		const code = [
			"import { workflow } from '@n8n/workflow-sdk';",
			'',
			'// a comment',
			"import { node } from '@n8n/workflow-sdk';",
			'',
			"export default workflow('id', 'Name');",
		].join('\n');
		expect(stripImportStatements(code)).toBe("export default workflow('id', 'Name');");
	});

	it('removes side-effect imports', () => {
		const code = "import 'polyfill';\nexport default workflow('id', 'Name');";
		expect(stripImportStatements(code)).toBe("export default workflow('id', 'Name');");
	});

	it('leaves code with no imports untouched', () => {
		const code = "export default workflow('id', 'Name');";
		expect(stripImportStatements(code)).toBe(code);
	});

	/**
	 * A Code node's script is carried as a template literal inside the workflow.
	 * That script legitimately contains its own import lines, and stripping them
	 * would silently corrupt the user's node — so only the leading block goes.
	 */
	it('does not touch an import inside a Code node template literal', () => {
		const code = [
			"import { workflow, node } from '@n8n/workflow-sdk';",
			"export default workflow('id', 'Name').add(node({",
			"  type: 'n8n-nodes-base.code',",
			'  config: { jsCode: `',
			"import { readFile } from 'node:fs/promises';",
			'return await readFile(x);',
			'` },',
			'}));',
		].join('\n');

		const stripped = stripImportStatements(code);
		expect(stripped).toContain("import { readFile } from 'node:fs/promises';");
		expect(stripped.startsWith('export default')).toBe(true);
	});

	it('leaves a truncated import in place rather than swallowing the file', () => {
		const code = "import {\n  workflow,\nexport default workflow('id', 'Name');";
		expect(stripImportStatements(code)).toBe(code);
	});
});
