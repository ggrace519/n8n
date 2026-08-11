import { defineConfig, globalIgnores } from 'eslint/config';
import { nodeConfig } from '@n8n/eslint-config/node';

export default defineConfig(globalIgnores(['dist/**']), nodeConfig, {
	rules: {
		// Tool descriptors and SDK constants use snake_case tool names and mixed-case
		// display titles as object-literal properties; skip naming checks for those.
		'@typescript-eslint/naming-convention': [
			'error',
			{
				selector: 'objectLiteralProperty',
				format: null,
			},
		],
	},
});
