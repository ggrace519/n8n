import { RESOURCES } from '@/constants';
import {
	API_KEY_SCOPES,
	API_KEY_SCOPE_BACKED_BY,
	getApiKeyScopesForPrincipal,
	getApiKeyScopesForRole,
	PROJECT_CHECKED_API_KEY_SCOPES,
} from '@/public-api-permissions';
import {
	GLOBAL_ADMIN_SCOPES,
	GLOBAL_MEMBER_SCOPES,
	GLOBAL_OWNER_SCOPES,
} from '@/roles/scopes/global-scopes';
import { PERSONAL_PROJECT_OWNER_SCOPES } from '@/roles/scopes/project-scopes';
import { ALL_SCOPES } from '@/scope-information';
import type { Scope } from '@/types';

const asPrincipal = (scopes: Scope[]) => ({ role: { scopes: scopes.map((slug) => ({ slug })) } });

describe('public API key scopes', () => {
	/**
	 * The check that was missing. A key may only hold what its role holds, matched
	 * by exact slug, so an API-key scope with no counterpart in the RBAC catalog
	 * (directly or via `API_KEY_SCOPE_BACKED_BY`) can be granted to nobody and its
	 * routes answer 403 to everyone. 13 scopes were in that state.
	 */
	test('every API key scope is grantable to the instance owner', () => {
		const grantable = new Set(getApiKeyScopesForRole(asPrincipal(GLOBAL_OWNER_SCOPES)));

		expect(API_KEY_SCOPES.filter((scope) => !grantable.has(scope))).toEqual([]);
	});

	test('every API key scope is grantable to an admin', () => {
		const grantable = new Set(getApiKeyScopesForRole(asPrincipal(GLOBAL_ADMIN_SCOPES)));

		expect(API_KEY_SCOPES.filter((scope) => !grantable.has(scope))).toEqual([]);
	});

	test('every backing scope exists in the RBAC catalog', () => {
		const unknown = Object.values(API_KEY_SCOPE_BACKED_BY).filter(
			(scope) => !ALL_SCOPES.includes(scope),
		);

		expect(unknown).toEqual([]);
	});

	test('only bridges API key scopes that the RBAC catalog does not already name', () => {
		const rbacScopes = new Set<string>();
		for (const [resource, operations] of Object.entries(RESOURCES)) {
			for (const operation of operations) rbacScopes.add(`${resource}:${operation}`);
		}

		// A bridge for a scope that already exists as an RBAC scope would silently
		// redirect it to a different permission.
		const redundant = Object.keys(API_KEY_SCOPE_BACKED_BY).filter((scope) => rbacScopes.has(scope));

		expect(redundant).toEqual([]);
	});

	describe('project-derived scopes', () => {
		const member = () =>
			getApiKeyScopesForPrincipal(GLOBAL_MEMBER_SCOPES, PERSONAL_PROJECT_OWNER_SCOPES);

		test('a member with a personal project gets exactly the project-checked scopes plus their global ones', () => {
			const expected = new Set([
				...PROJECT_CHECKED_API_KEY_SCOPES,
				...getApiKeyScopesForPrincipal(GLOBAL_MEMBER_SCOPES, []),
			]);

			expect(member().sort()).toEqual([...expected].sort());
		});

		test.each([
			'project:update',
			'project:delete',
			'credential:list',
			'insights:read',
			'workflow:import',
		] as const)('never derives %s from a project role', (scope) => {
			expect(member()).not.toContain(scope);
		});

		test('still grants those scopes when the global role holds them', () => {
			const scopes = getApiKeyScopesForPrincipal(GLOBAL_OWNER_SCOPES, []);

			expect(scopes).toEqual(expect.arrayContaining(['project:update', 'credential:list']));
		});

		test('does not grant a project-checked scope no project role backs', () => {
			const scopes = getApiKeyScopesForPrincipal([], ['workflow:read']);

			// `executionTags:list` is bridged to `workflow:read` (API_KEY_SCOPE_BACKED_BY).
			expect(scopes.sort()).toEqual(['executionTags:list', 'workflow:read']);
		});

		test('couples legacy activate/deactivate to project-held publish/unpublish', () => {
			const scopes = getApiKeyScopesForPrincipal([], ['workflow:publish', 'workflow:unpublish']);

			expect(scopes.sort()).toEqual(['workflow:activate', 'workflow:deactivate']);
		});

		test('every project-checked scope is in the API key catalog', () => {
			expect(PROJECT_CHECKED_API_KEY_SCOPES.filter((s) => !API_KEY_SCOPES.includes(s))).toEqual([]);
		});
	});

	test('does not grant a bridged scope to a principal lacking the backing scope', () => {
		const grantable = new Set(
			getApiKeyScopesForRole(asPrincipal(['dataTable:readRow', 'workflow:read'])),
		);

		expect(grantable.has('dataTableRow:read')).toBe(true);
		expect(grantable.has('executionTags:list')).toBe(true);

		// `dataTable:writeRow` was not held, so nothing riding on it is grantable.
		expect(grantable.has('dataTableRow:create')).toBe(false);
		expect(grantable.has('dataTableRow:delete')).toBe(false);
		expect(grantable.has('testRun:create')).toBe(false);
	});
});
