/**
 * Run: node --test scripts/check-no-ee-yaml-specifier.test.mjs
 *
 * Unit tests over the pure matcher only, with synthetic fixtures — deliberately
 * NOT asserting anything about the live public-api tree, whose `.ee` specifiers
 * get repointed by E21 (a real-tree assertion would flip red the moment that
 * lands). The one-time live proof that it catches the real users specs and
 * ignores .defork prose is evidence for the handoff, not a committed test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findEeSpecifiers, EE_PATTERN } from './check-no-ee-yaml-specifier.mjs';

describe('findEeSpecifiers', () => {
	it('flags an x-eov-operation-handler pointing at a .ee handler', () => {
		const f = findEeSpecifiers('  x-eov-operation-handler: v1/handlers/users/users.handler.ee\n');
		assert.equal(f.length, 1);
		assert.equal(f[0].key, 'x-eov-operation-handler');
		assert.equal(f[0].line, 1);
		assert.equal(f[0].value, 'v1/handlers/users/users.handler.ee');
	});

	it('flags a $ref to a .ee spec file (quoted)', () => {
		const f = findEeSpecifiers("    - $ref: './schemas/user.ee.yml'\n");
		assert.equal(f.length, 1);
		assert.equal(f[0].key, '$ref');
		assert.equal(f[0].value, './schemas/user.ee.yml');
	});

	it('flags a .ee/ directory segment mid-path', () => {
		const f = findEeSpecifiers('  x-eov-operation-handler: v1/handlers/foo.ee/bar.handler\n');
		assert.equal(f.length, 1);
	});

	it('passes a clean specifier (no .ee)', () => {
		assert.deepEqual(
			findEeSpecifiers('  x-eov-operation-handler: v1/handlers/tags/tags.handler\n'),
			[],
		);
	});

	it('passes a clean $ref', () => {
		assert.deepEqual(
			findEeSpecifiers("    - $ref: '../../../../shared/spec/parameters/limit.yml'\n"),
			[],
		);
	});

	// The core design constraint: target the specifier POSITION, not the substring.
	it('ignores .ee inside a NON-specifier key value (prose in a description)', () => {
		assert.deepEqual(
			findEeSpecifiers('  description: The legacy users.handler.ee flow is documented here.\n'),
			[],
		);
	});

	it('ignores .ee in a whole-line YAML comment', () => {
		assert.deepEqual(
			findEeSpecifiers('  # historical note: users.handler.ee used to live here\n'),
			[],
		);
	});

	it('ignores a trailing comment when the specifier value itself is clean', () => {
		assert.deepEqual(
			findEeSpecifiers('  x-eov-operation-handler: v1/handlers/tags/tags.handler  # was .ee\n'),
			[],
		);
	});

	it('still flags a real .ee value that carries a trailing comment', () => {
		const f = findEeSpecifiers(
			'  x-eov-operation-handler: v1/handlers/users/users.handler.ee  # TODO\n',
		);
		assert.equal(f.length, 1);
		assert.equal(f[0].value, 'v1/handlers/users/users.handler.ee');
	});

	it('reports every occurrence with correct line numbers', () => {
		const doc = [
			'get:',
			'  x-eov-operation-handler: v1/handlers/users/users.handler.ee',
			'  summary: ok',
			'post:',
			'  x-eov-operation-handler: v1/handlers/users/users.handler.ee',
			'',
		].join('\n');
		const f = findEeSpecifiers(doc);
		assert.equal(f.length, 2);
		assert.deepEqual(
			f.map((x) => x.line),
			[2, 5],
		);
	});

	it('does not over-match: .eek is not a .ee reference', () => {
		assert.equal(EE_PATTERN.test('some/path.eek'), false);
		assert.deepEqual(findEeSpecifiers('  $ref: some/path.eek\n'), []);
	});
});
