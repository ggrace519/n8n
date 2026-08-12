#!/usr/bin/env node
/**
 * Provenance guard for Enterprise-licensed (`.ee`) references in OpenAPI spec
 * YAML. This fork removed all `.ee` code and its git history under
 * LICENSE_EE.md; a spec that still points a route at a `.ee` handler either
 * reintroduces removed code or 500s by containment. The `no-import-enterprise-edition`
 * ESLint rule already catches `.ee` in TS/JS import/export nodes — but ESLint
 * never parses YAML, so an `x-eov-operation-handler` (or `$ref`) specifier
 * carrying `.ee` slips past it. This is exactly how the public-API `users`
 * handler gap hid. This script closes that hole for the specifier position.
 *
 * It is deliberately NOT a substring scan: `.ee` appears legitimately in prose
 * all over a de-fork repo (skills, changelogs, .defork/*.md all *discuss* it).
 * We parse each line as a YAML mapping entry and only test the VALUE of a known
 * module-specifier key. Prose, comments, and non-specifier fields are ignored
 * by construction.
 *
 * ponytail: line-oriented, matching the flat one-key-per-line shape these
 * OpenAPI path files actually use. It does not resolve YAML anchors or flow
 * mappings; if the specs ever adopt those for a specifier key, switch to a real
 * YAML parse. The `--json` flag emits findings for tooling.
 *
 * Usage:
 *   node scripts/check-no-ee-yaml-specifier.mjs [scanRoot] [--json]
 *   (default scanRoot: packages/cli/src/public-api)
 * Exit: 0 clean · 1 violations found · 2 usage/IO error.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Same matcher as the ESLint rule (no-import-enterprise-edition): a `.ee`
// directory segment (`foo.ee/bar`), a `.ee.` filename infix (`foo.ee.js`), or a
// bare `.ee` suffix (`./foo.ee`). Kept byte-identical on purpose.
export const EE_PATTERN = /\.ee(\.|\/|$)/;

// Keys whose value is a module/file specifier a loader will resolve — the only
// positions where `.ee` means "load Enterprise code", not "mention it".
export const SPECIFIER_KEYS = ['x-eov-operation-handler', '$ref'];

const KEY_ALT = SPECIFIER_KEYS.map((k) => k.replace(/[$]/g, '\\$&')).join('|');
// ^ optional indent, optional `- ` list-item dash (a $ref is usually a list
// entry: `- $ref: '...'`), (key): value, ignoring trailing YAML `# comment`.
const SPECIFIER_LINE = new RegExp(`^\\s*(?:-\\s+)?(${KEY_ALT})\\s*:\\s*(.+?)\\s*$`);

const unquote = (raw) => {
	const s = raw.replace(/\s+#.*$/, '').trim(); // strip trailing comment
	if (
		(s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
		(s.startsWith('"') && s.endsWith('"') && s.length >= 2)
	) {
		return s.slice(1, -1);
	}
	return s;
};

/**
 * Find `.ee` specifiers in one file's content.
 * @returns {Array<{ line: number, key: string, value: string }>}
 */
export function findEeSpecifiers(content) {
	const findings = [];
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (/^\s*#/.test(raw)) continue; // whole-line YAML comment: never a specifier
		const m = SPECIFIER_LINE.exec(raw);
		if (!m) continue;
		const value = unquote(m[2]);
		if (EE_PATTERN.test(value)) {
			findings.push({ line: i + 1, key: m[1], value });
		}
	}
	return findings;
}

function walkYaml(root) {
	const out = [];
	const recurse = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) recurse(full);
			else if (/\.ya?ml$/.test(entry.name)) out.push(full);
		}
	};
	recurse(root);
	return out;
}

function main(argv) {
	const json = argv.includes('--json');
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
	const scanArg = argv.find((a) => !a.startsWith('--')) ?? 'packages/cli/src/public-api';
	const scanRoot = join(repoRoot, scanArg);

	let stat;
	try {
		stat = statSync(scanRoot);
	} catch {
		console.error(`check-no-ee-yaml-specifier: scan root not found: ${scanArg}`);
		return 2;
	}
	if (!stat.isDirectory()) {
		console.error(`check-no-ee-yaml-specifier: scan root is not a directory: ${scanArg}`);
		return 2;
	}

	const violations = [];
	for (const file of walkYaml(scanRoot)) {
		for (const f of findEeSpecifiers(readFileSync(file, 'utf8'))) {
			violations.push({ file: relative(repoRoot, file), ...f });
		}
	}

	if (json) {
		console.log(JSON.stringify(violations, null, 2));
		return violations.length ? 1 : 0;
	}

	if (violations.length === 0) {
		console.log(`check-no-ee-yaml-specifier: clean (${scanArg})`);
		return 0;
	}

	console.error(
		`\nEnterprise-licensed (.ee) specifier found in OpenAPI spec YAML:\n\n` +
			violations.map((v) => `  ${v.file}:${v.line}  ${v.key}: ${v.value}`).join('\n') +
			`\n\nAll .ee code was removed from this fork under LICENSE_EE.md. A spec must not\n` +
			`point a route at a .ee handler — repoint it at the clean-room fair-code\n` +
			`replacement handler (drop the .ee suffix once the replacement exists).\n` +
			`Do not port the removed handler from git history or upstream.\n`,
	);
	return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main(process.argv.slice(2)));
}
