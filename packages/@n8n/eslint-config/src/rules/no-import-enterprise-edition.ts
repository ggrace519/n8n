import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

/**
 * Matches any module specifier that references Enterprise-licensed (`.ee`) code:
 * a `.ee` directory segment (`foo.ee/bar`), a `.ee.` filename infix
 * (`foo.ee.js`), or a bare `.ee` suffix (`@scope/pkg.ee`, `./foo.ee`).
 */
const EE_PATTERN = /\.ee(\.|\/|$)/;

export const NoImportEnterpriseEditionRule = ESLintUtils.RuleCreator.withoutDocs({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow importing or re-exporting Enterprise-licensed (.ee) modules. This fork removed all .ee code and its git history under LICENSE_EE.md; reintroducing it (or a copy derived from it) would violate that license. Build a fair-code replacement instead.',
		},
		messages: {
			noImportEnterpriseEdition:
				'Do not import or re-export from Enterprise-licensed (.ee) paths. All .ee code was removed from this fork under LICENSE_EE.md — do not reintroduce it or port it from git history; write a clean-room fair-code replacement instead.',
		},
		schema: [],
	},
	defaultOptions: [],
	create(context) {
		const reportIfEe = (source: TSESTree.Node | null | undefined) => {
			if (
				source?.type === TSESTree.AST_NODE_TYPES.Literal &&
				typeof source.value === 'string' &&
				EE_PATTERN.test(source.value)
			) {
				context.report({ node: source, messageId: 'noImportEnterpriseEdition' });
			}
		};

		return {
			// import ... from '...ee'
			ImportDeclaration: (node) => reportIfEe(node.source),
			// export { x } from '...ee'
			ExportNamedDeclaration: (node) => reportIfEe(node.source),
			// export * from '...ee'
			ExportAllDeclaration: (node) => reportIfEe(node.source),
			// await import('...ee')
			ImportExpression: (node) => reportIfEe(node.source),
		};
	},
});
