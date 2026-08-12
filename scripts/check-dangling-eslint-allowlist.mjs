#!/usr/bin/env node
/**
 * Guard against dangling file-path entries in an ESLint flat config. The
 * ratchet allowlists in `packages/cli/eslint.config.mjs` (`files: [...]` arrays
 * that turn a rule off pending migration) accumulate concrete paths; when a
 * file is deleted or renamed, its allowlist entry is easy to leave behind. A
 * stale entry is dead weight and actively misleading — it looks like it excuses
 * a file that no longer exists.
 *
 * On this de-fork the failure mode is specific: purged `.ee` files
 * (`users.handler.ee.ts`, `credentials.service.ee.ts`, the `evaluation.ee/` and
 * `provisioning.ee/` trees, …) left their allowlist entries behind. Those `.ee`
 * strings are invisible to `no-import-enterprise-edition`, which only inspects
 * TS/JS import nodes, not config string literals — the same blind spot the
 * OpenAPI-spec guard was written for, one file type over.
 *
 * The signal is existence, NOT the substring `.ee`: some `.ee` entries are
 * *intentional* (rebuilt fair-code files that kept a purged file's pre-existing
 * leak-baseline entry — those files exist and must pass). So we flag a concrete
 * path entry only when its target is missing on disk. This generalises past
 * `.ee` to any dangling entry, which is the more useful guard.
 *
 * ponytail: this is a lexical scan of quoted string literals, not a full JS
 * parse — good enough for the one-path-per-line shape these config arrays use.
 * It deliberately SKIPS glob entries (any glob metacharacter): a glob that
 * currently matches zero files (say a doublestar `handler.ee.ts` pattern) is
 * valid config, not a dangling path. Flagging dead globs would need glob
 * expansion — a separate check if it's ever wanted.
 *
 * Usage:
 *   node scripts/check-dangling-eslint-allowlist.mjs [config.mjs ...] [--json]
 *   (default: packages/cli/eslint.config.mjs)
 * Exit: 0 clean · 1 dangling entries found · 2 usage/IO error.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Glob metacharacters (minimatch): a literal carrying any of these is a pattern,
// not a concrete path, so we cannot existence-check it and skip it.
const GLOB_METACHAR = /[*?[\]{}()!]/;
// Relative path (`./` or `../`) ending in a source-file extension.
const SOURCE_PATH = /^\.\.?\/.*\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
// Every single/double-quoted string literal on a line.
const STRING_LITERAL = /(['"])((?:\\.|(?!\1).)*)\1/g;

/**
 * Extract concrete (non-glob) relative source-path literals from config text.
 * Pure — no filesystem access.
 * @returns {Array<{ line: number, entry: string }>}
 */
export function extractPathEntries(content) {
	const out = [];
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		for (const m of lines[i].matchAll(STRING_LITERAL)) {
			const entry = m[2];
			if (GLOB_METACHAR.test(entry)) continue;
			if (!SOURCE_PATH.test(entry)) continue;
			out.push({ line: i + 1, entry });
		}
	}
	return out;
}

/**
 * Find entries whose target file is missing.
 * @param {string} content   config file text
 * @param {string} configDir directory the entries resolve against
 * @param {(absPath: string) => boolean} exists  existence probe (injectable for tests)
 * @returns {Array<{ line: number, entry: string }>}
 */
export function findDangling(content, configDir, exists = existsSync) {
	return extractPathEntries(content).filter((e) => !exists(resolve(configDir, e.entry)));
}

function main(argv) {
	const json = argv.includes('--json');
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
	const targets = argv.filter((a) => !a.startsWith('--'));
	if (targets.length === 0) targets.push('packages/cli/eslint.config.mjs');

	const dangling = [];
	for (const target of targets) {
		const configPath = resolve(repoRoot, target);
		let stat;
		try {
			stat = statSync(configPath);
		} catch {
			console.error(`check-dangling-eslint-allowlist: config not found: ${target}`);
			return 2;
		}
		if (!stat.isFile()) {
			console.error(`check-dangling-eslint-allowlist: not a file: ${target}`);
			return 2;
		}
		const content = readFileSync(configPath, 'utf8');
		for (const d of findDangling(content, dirname(configPath))) {
			dangling.push({ config: target, ...d });
		}
	}

	if (json) {
		console.log(JSON.stringify(dangling, null, 2));
		return dangling.length ? 1 : 0;
	}

	if (dangling.length === 0) {
		console.log(`check-dangling-eslint-allowlist: clean (${targets.join(', ')})`);
		return 0;
	}

	console.error(
		`\nDangling ESLint config entries — path points at a file that does not exist:\n\n` +
			dangling.map((d) => `  ${d.config}:${d.line}  ${d.entry}`).join('\n') +
			`\n\nRemove each stale entry. If a file was renamed, update the path; if it was\n` +
			`deleted (e.g. a purged .ee file), drop the entry — an allowlist line for a\n` +
			`file that no longer exists excuses nothing and misleads the next reader.\n`,
	);
	return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main(process.argv.slice(2)));
}
