import { RuleTester } from '@typescript-eslint/rule-tester';
import { NoImportEnterpriseEditionRule } from './no-import-enterprise-edition.js';

const ruleTester = new RuleTester();

ruleTester.run('no-import-enterprise-edition', NoImportEnterpriseEditionRule, {
	valid: [
		// Regular imports
		{
			code: 'import { SomeService } from "./services/some-service"',
			filename: '/Users/test/project/src/services/regular-service.ts',
		},
		{
			code: 'import { Config } from "@n8n/config"',
			filename: '/Users/test/project/src/services/service.ts',
		},
		// Re-exports of non-ee modules
		{
			code: 'export { helper } from "./utils/helper"',
			filename: '/Users/test/project/src/index.ts',
		},
		{
			code: 'export * from "./utils/helper"',
			filename: '/Users/test/project/src/index.ts',
		},
		// Dynamic import of a non-ee module
		{
			code: 'const m = import("./services/some-service")',
			filename: '/Users/test/project/src/index.ts',
		},
		// ".ee" substring that is NOT an .ee reference (no `.`, `/`, or end after `.ee`)
		{
			code: 'import { list } from "./employee/list"',
			filename: '/Users/test/project/src/index.ts',
		},
	],
	invalid: [
		// .ee directory segment
		{
			code: 'import { something } from "@n8n/package/environments.ee/file"',
			filename: '/Users/test/project/src/index.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		{
			code: 'import { EnterpriseService } from "environments.ee/enterprise-service"',
			filename: '/Users/test/project/src/services/service.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		// .ee. filename infix
		{
			code: 'import { WorkflowService } from "./workflow.service.ee"',
			filename: '/Users/test/project/src/workflows/workflows.controller.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		{
			code: 'import x from "./component.ee.vue"',
			filename: '/Users/test/project/src/App.vue',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		// bare .ee suffix (package name)
		{
			code: 'import { X } from "@n8n/ai-workflow-builder.ee"',
			filename: '/Users/test/project/src/index.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		// re-export from an .ee module
		{
			code: 'export { hasScope } from "./utilities/has-scope.ee"',
			filename: '/Users/test/project/packages/@n8n/permissions/src/index.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		{
			code: 'export * from "./types.ee"',
			filename: '/Users/test/project/packages/@n8n/permissions/src/index.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
		// dynamic import of an .ee module
		{
			code: 'const m = import("./source-control.ee/source-control.service.ee")',
			filename: '/Users/test/project/src/index.ts',
			errors: [{ messageId: 'noImportEnterpriseEdition' }],
		},
	],
});
