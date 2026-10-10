import { GLOBAL_CHAT_USER_SCOPES, GLOBAL_MEMBER_SCOPES } from '../scopes/global-scopes';
import {
	PERSONAL_PROJECT_OWNER_SCOPES,
	PROJECT_CHAT_USER_SCOPES,
	PROJECT_EDITOR_SCOPES,
	PROJECT_VIEWER_SCOPES,
	REGULAR_PROJECT_ADMIN_SCOPES,
} from '../scopes/project-scopes';

// Grants the surviving fair-code specs rely on; each was missing from the
// clean-room rebuild of the role sets.
describe('project role scope sets', () => {
	test.each([
		['personal owner', PERSONAL_PROJECT_OWNER_SCOPES],
		['admin', REGULAR_PROJECT_ADMIN_SCOPES],
		['editor', PROJECT_EDITOR_SCOPES],
		['viewer', PROJECT_VIEWER_SCOPES],
	])("a project %s can list the project's members", (_role, scopes) => {
		expect(scopes).toEqual(expect.arrayContaining(['project:list', 'project:read']));
	});

	test('a chat user holds no project scopes at all', () => {
		expect(PROJECT_CHAT_USER_SCOPES.filter((scope) => scope.startsWith('project:'))).toEqual([]);
	});

	test('a viewer can export workflows it can read, but not the project', () => {
		expect(PROJECT_VIEWER_SCOPES).toContain('workflow:export');
		expect(PROJECT_VIEWER_SCOPES).not.toContain('project:export');
		expect(PROJECT_VIEWER_SCOPES).not.toContain('workflow:import');
	});

	test('an editor can export the project', () => {
		expect(PROJECT_EDITOR_SCOPES).toEqual(
			expect.arrayContaining(['project:export', 'workflow:export', 'workflow:import']),
		);
	});
});

describe('global role scope sets', () => {
	test('a member can open the cross-project data-table overview but not list every project', () => {
		expect(GLOBAL_MEMBER_SCOPES).toContain('dataTable:list');
		expect(GLOBAL_MEMBER_SCOPES).not.toContain('dataTable:listProject');
	});

	test('a member manages only their own MCP OAuth clients and holds no MCP admin or key scopes', () => {
		expect(GLOBAL_MEMBER_SCOPES).toContain('mcp:oauth');
		expect(GLOBAL_MEMBER_SCOPES).not.toContain('mcp:manage');
		expect(GLOBAL_MEMBER_SCOPES).not.toContain('mcpApiKey:create');
	});

	test('a chat user cannot open the data-table overview', () => {
		expect(GLOBAL_CHAT_USER_SCOPES).not.toContain('dataTable:list');
	});
});
