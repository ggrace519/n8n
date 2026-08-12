/**
 * Names and labels for the workflow-builder tools.
 *
 * These are shared so the MCP server and the builder agent address the same
 * tool by the same name. `toolName` is the wire identifier — `mcp-scopes.ts`
 * grants access by it and `mcp.service.ts` registers by it, so changing one
 * without the other silently breaks authorization. A drift-guard test in
 * `packages/cli` asserts the two stay in lock-step.
 *
 * `displayTitle` is the human-facing label surfaced in tool annotations.
 */
export interface ToolDescriptor {
	readonly toolName: string;
	readonly displayTitle: string;
}

/** Search the node catalog by service name, trigger type, or utility function. */
export const CODE_BUILDER_SEARCH_NODES_TOOL: ToolDescriptor = {
	toolName: 'search_nodes',
	displayTitle: 'Search Workflow Nodes',
};

/** Resolve full parameter type definitions for specific node types. */
export const CODE_BUILDER_GET_NODE_TYPES_TOOL: ToolDescriptor = {
	toolName: 'get_node_types',
	displayTitle: 'Get workflow node types',
};

/**
 * Suggest nodes by category. Retained for parity with the builder agent's tool
 * set; the MCP server does not register it, so it carries no scope grant.
 */
export const CODE_BUILDER_GET_SUGGESTED_NODES_TOOL: ToolDescriptor = {
	toolName: 'get_suggested_nodes',
	displayTitle: 'Get suggested nodes',
};

/** Parse and validate workflow SDK code without persisting anything. */
export const CODE_BUILDER_VALIDATE_TOOL: ToolDescriptor = {
	toolName: 'validate_workflow',
	displayTitle: 'Validate Workflow Code',
};

/** Validate a single node's parameters against its schema. */
export const CODE_BUILDER_VALIDATE_NODE_TOOL: ToolDescriptor = {
	toolName: 'validate_node_config',
	displayTitle: 'Validating node config',
};

/** Serve the workflow SDK reference (also exposed as an MCP resource). */
export const MCP_GET_SDK_REFERENCE_TOOL: ToolDescriptor = {
	toolName: 'get_workflow_sdk_reference',
	displayTitle: 'Get SDK Reference',
};

/** Create a workflow from SDK code. */
export const MCP_CREATE_WORKFLOW_FROM_CODE_TOOL: ToolDescriptor = {
	toolName: 'create_workflow_from_code',
	displayTitle: 'Create Workflow from Code',
};

/** Archive a workflow. */
export const MCP_ARCHIVE_WORKFLOW_TOOL: ToolDescriptor = {
	toolName: 'archive_workflow',
	displayTitle: 'Archive Workflow',
};

/** Apply a batch of edits to an existing workflow. */
export const MCP_UPDATE_WORKFLOW_TOOL: ToolDescriptor = {
	toolName: 'update_workflow',
	displayTitle: 'Updating workflow',
};

/**
 * List the selectable values behind a node's resource-locator or load-options
 * method. Queries external services with stored credentials, hence the
 * credential scope rather than a workflow one.
 */
export const MCP_EXPLORE_NODE_RESOURCES_TOOL: ToolDescriptor = {
	toolName: 'explore_node_resources',
	displayTitle: 'Exploring node resources',
};

/** Serve design guidance for a named workflow technique. */
export const MCP_GET_WORKFLOW_BEST_PRACTICES_TOOL: ToolDescriptor = {
	toolName: 'get_workflow_best_practices',
	displayTitle: 'Getting workflow best practices',
};
