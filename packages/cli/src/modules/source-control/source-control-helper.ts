import type { SourceControlledFile } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { UserError } from 'n8n-workflow';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export function isSourceControlLicensed(): boolean {
	return Container.get(LicenseState).isSourceControlLicensed();
}

/**
 * Validate a git branch name before it reaches git or the stored preferences.
 * Allows nested names (`team/feature`) but rejects everything git's ref-format
 * rules refuse: leading `-` (would parse as an option), `..`, a `.lock`
 * suffix, leading/trailing `/` or `.`, empty segments, and any character
 * outside a conservative allowlist (which also excludes spaces and control
 * characters).
 */
export function isValidGitBranchName(branch: string): boolean {
	if (branch.length === 0 || branch.length > 250) return false;
	if (!/^[A-Za-z0-9._\-/]+$/.test(branch)) return false;
	if (branch.startsWith('-') || branch.startsWith('/') || branch.startsWith('.')) return false;
	if (branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) return false;
	if (branch.includes('..') || branch.includes('//')) return false;
	// No segment may start with a dot or a dash, or end with `.lock`.
	return branch
		.split('/')
		.every(
			(segment) =>
				segment.length > 0 &&
				!segment.startsWith('.') &&
				!segment.startsWith('-') &&
				!segment.endsWith('.lock'),
		);
}

/**
 * Whether an id may be used as a single path segment of a work-folder file
 * name. Resource ids are nanoids/UUIDs; anything else (separators, dots,
 * empty) must never be joined into a filesystem path.
 */
export function isSafePathSegmentId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Reject managed files that are symbolic links: a repository-provided symlink
 * would redirect reads/writes outside the work folder. A missing file passes —
 * there is nothing to follow, and the subsequent read/write fails or creates a
 * regular file.
 */
export async function assertNotSymlink(filePath: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(filePath);
	} catch {
		return;
	}
	// `stats` may be undefined under test-level fs mocks; only a real Stats
	// reporting a symlink is rejected.
	if (typeof stats?.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
		throw new UserError('Symbolic links are not supported in the source control folder');
	}
}

/**
 * Verify that the real (symlink-resolved) parent directory of `filePath` is
 * inside the real work folder. Guards against a managed *directory* having
 * been replaced by a symlink. Missing directories pass — they cannot be
 * traversed, and any subsequent read fails.
 */
export async function assertParentWithinFolder(filePath: string, rootDir: string): Promise<void> {
	let resolvedParent: string | undefined;
	let resolvedRoot: string | undefined;
	try {
		resolvedParent = await realpath(path.dirname(filePath));
		resolvedRoot = await realpath(rootDir);
	} catch {
		return;
	}
	// Non-string results only occur under test-level fs mocks.
	if (typeof resolvedParent !== 'string' || typeof resolvedRoot !== 'string') return;
	const relative = path.relative(resolvedRoot, resolvedParent);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new UserError('File path is outside the source control folder');
	}
}

/**
 * Merge credential data pulled from git over the locally stored (decrypted)
 * data. Git only carries sanitized stubs, so a blank string is a placeholder
 * for a locally kept secret and must not overwrite it; non-blank values
 * (edited expressions, numbers, booleans) are applied. Keys absent from the
 * incoming stub (e.g. `oauthTokenData`, which is never exported) keep their
 * local value.
 */
export function mergeCredentialData(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existing };
	for (const [key, incomingValue] of Object.entries(incoming)) {
		const existingValue = merged[key];
		if (incomingValue === '' && key in merged) continue;
		if (isPlainObject(incomingValue) && isPlainObject(existingValue)) {
			merged[key] = mergeCredentialData(existingValue, incomingValue);
			continue;
		}
		merged[key] = incomingValue;
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SourceControlPullTrackingInformation {
	userId: string;
	workflowUpdates: number;
	workflowConflicts: number;
	credConflicts: number;
}

/**
 * Aggregate a pull's status result into the counters shared by the
 * `source-control-user-pulled-api` and pull-UI telemetry events.
 */
export function getTrackingInformationFromPullResult(
	userId: string,
	result: SourceControlledFile[],
): SourceControlPullTrackingInformation {
	return {
		userId,
		workflowUpdates: result.filter((file) => file.type === 'workflow').length,
		workflowConflicts: result.filter((file) => file.type === 'workflow' && file.conflict).length,
		credConflicts: result.filter((file) => file.type === 'credential' && file.conflict).length,
	};
}

/** Classify a repository URL for the `source-control-settings-updated` event. */
export function getRepoType(repositoryUrl: string): 'github' | 'gitlab' | 'other' {
	if (repositoryUrl.includes('github.com')) return 'github';
	if (repositoryUrl.includes('gitlab.com')) return 'gitlab';
	return 'other';
}
