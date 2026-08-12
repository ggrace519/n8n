/**
 * Run: node --test scripts/check-dangling-eslint-allowlist.test.mjs
 *
 * Unit tests over the pure extractor + the existence filter (fs injected).
 * The one-time live proof that it flags exactly the real config's known-dead
 * entries and nothing among the live ones is evidence for the handoff, not a
 * committed test (the real config's dead set shrinks as the lead's cleanup lands).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractPathEntries, findDangling } from './check-dangling-eslint-allowlist.mjs';

describe('extractPathEntries', () => {
	it('extracts a concrete relative source path (single-quoted)', () => {
		assert.deepEqual(
			extractPathEntries("      './src/public-api/v1/handlers/users/users.handler.ee.ts',\n"),
			[{ line: 1, entry: './src/public-api/v1/handlers/users/users.handler.ee.ts' }],
		);
	});

	it('extracts a double-quoted path too', () => {
		assert.deepEqual(extractPathEntries('  "./src/foo.ts",\n'), [
			{ line: 1, entry: './src/foo.ts' },
		]);
	});

	it('skips glob entries (they are patterns, not concrete paths)', () => {
		assert.deepEqual(
			extractPathEntries("  './src/public-api/v1/handlers/**/*.handler.ee.ts',\n"),
			[],
		);
		assert.deepEqual(extractPathEntries("  './src/public-api/**/__tests__/**/*.ts',\n"), []);
	});

	it('skips non-path strings (rule ids, plugin names)', () => {
		assert.deepEqual(
			extractPathEntries("  'n8n-local-rules/no-repository-in-public-api-handler': 'off',\n"),
			[],
		);
		assert.deepEqual(extractPathEntries("  '@typescript-eslint/no-restricted-imports',\n"), []);
	});

	it('skips a relative import with no source extension', () => {
		assert.deepEqual(extractPathEntries("import x from './utils';\n"), []);
	});

	it('reports every entry with correct line numbers', () => {
		const doc = ['files: [', "  './src/a.service.ts',", "  './src/b.handler.ee.ts',", '],'].join(
			'\n',
		);
		assert.deepEqual(extractPathEntries(doc), [
			{ line: 2, entry: './src/a.service.ts' },
			{ line: 3, entry: './src/b.handler.ee.ts' },
		]);
	});
});

describe('findDangling', () => {
	const doc = ["  './src/live.service.ts',", "  './src/purged.service.ee.ts',"].join('\n');

	it('flags the entry whose target is missing, passes the one that exists', () => {
		const exists = (abs) => abs.endsWith('/src/live.service.ts'); // only the live one exists
		assert.deepEqual(findDangling(doc, '/repo/pkg', exists), [
			{ line: 2, entry: './src/purged.service.ee.ts' },
		]);
	});

	it('is existence-based, not .ee-based: an existing .ee path is NOT flagged', () => {
		const exists = () => true; // pretend every target exists
		assert.deepEqual(findDangling("  './src/still-here.ee.ts',\n", '/repo/pkg', exists), []);
	});

	it('flags a non-.ee dangling path too (generalises past .ee)', () => {
		const exists = () => false;
		assert.deepEqual(findDangling("  './src/renamed-away.service.ts',\n", '/repo/pkg', exists), [
			{ line: 1, entry: './src/renamed-away.service.ts' },
		]);
	});

	it('resolves entries against the given config dir', () => {
		const seen = [];
		findDangling("  './src/x.ts',\n", '/repo/pkg', (abs) => {
			seen.push(abs);
			return true;
		});
		assert.deepEqual(seen, ['/repo/pkg/src/x.ts']);
	});
});
