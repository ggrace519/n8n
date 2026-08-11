/**
 * Tool descriptors and SDK constants (fair-code layer 1).
 *
 * Each descriptor pairs the wire `toolName` (the identifier the MCP server and
 * the code-builder agent register the tool under) with a human-readable
 * `displayTitle` (surfaced in tool-call annotations / progress UI).
 *
 * The `toolName` values are the ones the n8n MCP server exposes publicly
 * (`search_nodes`, `get_node_types`, …); the MCP tool registrations in
 * `packages/cli/src/modules/mcp/tools/workflow-builder/*` set each tool's
 * `name` to the matching descriptor's `toolName`, so these must stay in sync
 * with that external surface.
 */

export interface ToolDescriptor {
	/** Stable wire identifier the tool is registered and invoked under. */
	toolName: string;
	/** Human-readable label shown in tool-call annotations. */
	displayTitle: string;
}

// --- Code-builder agent tools (also surfaced via the MCP server) ------------

export const CODE_BUILDER_SEARCH_NODES_TOOL: ToolDescriptor = {
	toolName: 'search_nodes',
	displayTitle: 'Search nodes',
};

export const CODE_BUILDER_GET_NODE_TYPES_TOOL: ToolDescriptor = {
	toolName: 'get_node_types',
	displayTitle: 'Get node types',
};

export const CODE_BUILDER_GET_SUGGESTED_NODES_TOOL: ToolDescriptor = {
	toolName: 'get_suggested_nodes',
	displayTitle: 'Get suggested nodes',
};

export const CODE_BUILDER_VALIDATE_TOOL: ToolDescriptor = {
	toolName: 'validate_workflow',
	displayTitle: 'Validate workflow',
};

export const CODE_BUILDER_VALIDATE_NODE_TOOL: ToolDescriptor = {
	toolName: 'validate_node_config',
	displayTitle: 'Validate node config',
};

// --- MCP-server-only tools ---------------------------------------------------

export const MCP_GET_SDK_REFERENCE_TOOL: ToolDescriptor = {
	toolName: 'get_sdk_reference',
	displayTitle: 'Get SDK reference',
};

export const MCP_CREATE_WORKFLOW_FROM_CODE_TOOL: ToolDescriptor = {
	toolName: 'create_workflow_from_code',
	displayTitle: 'Create workflow from code',
};

export const MCP_ARCHIVE_WORKFLOW_TOOL: ToolDescriptor = {
	toolName: 'archive_workflow',
	displayTitle: 'Archive workflow',
};

export const MCP_UPDATE_WORKFLOW_TOOL: ToolDescriptor = {
	toolName: 'update_workflow',
	displayTitle: 'Update workflow',
};

export const MCP_EXPLORE_NODE_RESOURCES_TOOL: ToolDescriptor = {
	toolName: 'explore_node_resources',
	displayTitle: 'Explore node resources',
};

export const MCP_GET_WORKFLOW_BEST_PRACTICES_TOOL: ToolDescriptor = {
	toolName: 'get_workflow_best_practices',
	displayTitle: 'Get workflow best practices',
};

/**
 * The canonical import line prepended to generated workflow SDK code. The
 * `stripImportStatements` helper removes import lines before parsing, so this
 * is re-added when presenting code and stripped again before interpretation.
 */
export const SDK_IMPORT_STATEMENT = "import { workflow } from '@n8n/workflow-sdk';";
