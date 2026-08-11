import { WORKFLOW_PATTERNS_DETAILED } from '@n8n/workflow-sdk/prompts/sdk-reference';

import { SDK_IMPORT_STATEMENT } from '../sdk-import-statement';
import * as descriptors from '../tool-descriptors';
import type { ToolDescriptor } from '../tool-descriptors';

const ALL: Array<[string, ToolDescriptor]> = Object.entries(descriptors).filter(
	(entry): entry is [string, ToolDescriptor] => 'toolName' in entry[1],
);

describe('tool descriptors', () => {
	it('exposes a descriptor for every workflow-builder tool', () => {
		expect(ALL).toHaveLength(11);
	});

	it('gives every tool a distinct name', () => {
		const names = ALL.map(([, descriptor]) => descriptor.toolName);
		expect(new Set(names).size).toBe(names.length);
	});

	it.each(ALL)('%s has a non-empty name and title', (_exportName, descriptor) => {
		expect(descriptor.toolName).toMatch(/^[a-z][a-z0-9_]*$/);
		expect(descriptor.displayTitle.length).toBeGreaterThan(0);
	});

	/**
	 * These strings are the wire contract: `mcp-scopes.ts` grants access by them
	 * and the MCP server registers by them. `packages/cli` has a drift guard that
	 * fails if the two disagree, but it can only compare the two sides against
	 * each other — this pins the actual values so a coordinated rename is a
	 * deliberate act rather than a silent one.
	 */
	it('matches the registered MCP tool names', () => {
		expect(Object.fromEntries(ALL.map(([name, d]) => [name, d.toolName]))).toEqual({
			CODE_BUILDER_SEARCH_NODES_TOOL: 'search_nodes',
			CODE_BUILDER_GET_NODE_TYPES_TOOL: 'get_node_types',
			CODE_BUILDER_GET_SUGGESTED_NODES_TOOL: 'get_suggested_nodes',
			CODE_BUILDER_VALIDATE_TOOL: 'validate_workflow',
			CODE_BUILDER_VALIDATE_NODE_TOOL: 'validate_node_config',
			MCP_GET_SDK_REFERENCE_TOOL: 'get_workflow_sdk_reference',
			MCP_CREATE_WORKFLOW_FROM_CODE_TOOL: 'create_workflow_from_code',
			MCP_ARCHIVE_WORKFLOW_TOOL: 'archive_workflow',
			MCP_UPDATE_WORKFLOW_TOOL: 'update_workflow',
			MCP_EXPLORE_NODE_RESOURCES_TOOL: 'explore_node_resources',
			MCP_GET_WORKFLOW_BEST_PRACTICES_TOOL: 'get_workflow_best_practices',
		});
	});
});

describe('SDK_IMPORT_STATEMENT', () => {
	const imported = SDK_IMPORT_STATEMENT.replace(/^import\s*\{/, '')
		.replace(/\}\s*from.*$/, '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);

	it('is a complete import statement from the SDK package', () => {
		expect(SDK_IMPORT_STATEMENT).toMatch(/^import \{.+\} from '@n8n\/workflow-sdk';$/);
		expect(imported.length).toBeGreaterThan(0);
	});

	it('names each builder once', () => {
		expect(new Set(imported).size).toBe(imported.length);
	});

	/**
	 * The SDK reference we serve stitches this statement together with the SDK's
	 * own pattern examples, which carry their own copy of the same line. If the
	 * two drift, clients read an import list that contradicts the very snippets
	 * printed underneath it.
	 *
	 * Anchored to the SDK's constant rather than the package's public exports:
	 * these names are resolved by the AST interpreter's function table when the
	 * code is parsed, not by real module resolution, so they include builders
	 * (`reranker`) that `@n8n/workflow-sdk` never re-exports from its index.
	 */
	it('matches the import line in the SDK reference patterns', () => {
		expect(WORKFLOW_PATTERNS_DETAILED).toContain(SDK_IMPORT_STATEMENT);
	});
});
