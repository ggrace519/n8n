import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	assertNotSymlink,
	assertParentWithinFolder,
	isSafePathSegmentId,
	isValidGitBranchName,
	mergeCredentialData,
} from '../source-control-helper';

describe('isValidGitBranchName', () => {
	test.each([
		'main',
		'release',
		'team/feature',
		'a/b/c',
		'feature-123',
		'v1.2.3',
		'Feature_Branch',
	])('accepts %s', (branch) => {
		expect(isValidGitBranchName(branch)).toBe(true);
	});

	test.each([
		['', 'empty'],
		['-detach', 'leading dash'],
		['--force', 'option-like'],
		['a..b', 'double dot'],
		['branch.lock', '.lock suffix'],
		['nested/branch.lock', 'nested .lock suffix'],
		['branch/', 'trailing slash'],
		['/branch', 'leading slash'],
		['branch.', 'trailing dot'],
		['.hidden', 'leading dot'],
		['a/.hidden', 'segment leading dot'],
		['a/-flag', 'segment leading dash'],
		['a//b', 'empty segment'],
		['has space', 'space'],
		['has\ttab', 'control character'],
		['branch\n', 'newline'],
		['a~b', 'tilde'],
		['a^b', 'caret'],
		['a:b', 'colon'],
		['a?b', 'question mark'],
		['a[b', 'bracket'],
		['a\\b', 'backslash'],
	])('rejects %s (%s)', (branch) => {
		expect(isValidGitBranchName(branch)).toBe(false);
	});
});

describe('isSafePathSegmentId', () => {
	test.each(['abc123', 'A-b_C', '1234-asdf'])('accepts %s', (id) => {
		expect(isSafePathSegmentId(id)).toBe(true);
	});

	test.each(['', '..', 'a/b', 'a\\b', 'a.json', '../../etc/passwd', 'a b', 'a\0b'])(
		'rejects %s',
		(id) => {
			expect(isSafePathSegmentId(id)).toBe(false);
		},
	);
});

describe('mergeCredentialData', () => {
	it('keeps existing secrets where the incoming stub is blank', () => {
		const merged = mergeCredentialData(
			{ apiKey: 'real-secret', url: 'https://api.example.com' },
			{ apiKey: '', url: '' },
		);
		expect(merged).toEqual({ apiKey: 'real-secret', url: 'https://api.example.com' });
	});

	it('applies non-blank incoming values', () => {
		const merged = mergeCredentialData(
			{ apiKey: 'real-secret', region: 'us-east-1', port: 443, secure: true },
			{ apiKey: '', region: 'eu-west-1', port: 8443, secure: false },
		);
		expect(merged).toEqual({
			apiKey: 'real-secret',
			region: 'eu-west-1',
			port: 8443,
			secure: false,
		});
	});

	it('preserves keys absent from the incoming stub, including oauthTokenData', () => {
		const merged = mergeCredentialData(
			{ clientId: 'id', clientSecret: 'secret', oauthTokenData: { accessToken: 'token' } },
			{ clientId: '', clientSecret: '' },
		);
		expect(merged).toEqual({
			clientId: 'id',
			clientSecret: 'secret',
			oauthTokenData: { accessToken: 'token' },
		});
	});

	it('merges nested objects recursively', () => {
		const merged = mergeCredentialData(
			{ nested: { password: 'kept', host: 'old-host' }, top: 'kept-too' },
			{ nested: { password: '', host: 'new-host' }, top: '' },
		);
		expect(merged).toEqual({
			nested: { password: 'kept', host: 'new-host' },
			top: 'kept-too',
		});
	});

	it('stores blank strings for keys that have no local value', () => {
		const merged = mergeCredentialData({}, { apiKey: '', flag: true });
		expect(merged).toEqual({ apiKey: '', flag: true });
	});
});

describe('path guards', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'sc-guard-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	describe('assertNotSymlink', () => {
		it('passes for a regular file', async () => {
			const filePath = path.join(root, 'regular.json');
			await writeFile(filePath, '{}');
			await expect(assertNotSymlink(filePath)).resolves.toBeUndefined();
		});

		it('passes for a missing file', async () => {
			await expect(assertNotSymlink(path.join(root, 'missing.json'))).resolves.toBeUndefined();
		});

		it('rejects a symlinked file', async () => {
			const target = path.join(root, 'target.json');
			await writeFile(target, '{}');
			const link = path.join(root, 'link.json');
			await symlink(target, link);
			await expect(assertNotSymlink(link)).rejects.toThrow(
				'Symbolic links are not supported in the source control folder',
			);
		});
	});

	describe('assertParentWithinFolder', () => {
		it('passes for a file directly in the root', async () => {
			await expect(
				assertParentWithinFolder(path.join(root, 'file.json'), root),
			).resolves.toBeUndefined();
		});

		it('passes for a file in a real subdirectory', async () => {
			const sub = path.join(root, 'workflows');
			await mkdir(sub);
			await expect(
				assertParentWithinFolder(path.join(sub, 'file.json'), root),
			).resolves.toBeUndefined();
		});

		it('passes when the parent directory does not exist', async () => {
			await expect(
				assertParentWithinFolder(path.join(root, 'nope', 'file.json'), root),
			).resolves.toBeUndefined();
		});

		it('rejects when the parent directory is a symlink escaping the root', async () => {
			const outside = await mkdtemp(path.join(tmpdir(), 'sc-outside-'));
			try {
				const link = path.join(root, 'workflows');
				await symlink(outside, link);
				await expect(assertParentWithinFolder(path.join(link, 'file.json'), root)).rejects.toThrow(
					'File path is outside the source control folder',
				);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});

		it('rejects a path lexically outside the root', async () => {
			const outside = await mkdtemp(path.join(tmpdir(), 'sc-outside2-'));
			try {
				await expect(
					assertParentWithinFolder(path.join(outside, 'file.json'), root),
				).rejects.toThrow('File path is outside the source control folder');
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});
	});
});
