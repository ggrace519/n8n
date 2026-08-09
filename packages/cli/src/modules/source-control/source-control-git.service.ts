import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { Cipher } from 'n8n-core';
import { jsonParse, OperationalError, UnexpectedError, UserError } from 'n8n-workflow';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
	CommitResult,
	DiffResult,
	FetchResult,
	PullResult,
	PushResult,
	SimpleGit,
	SimpleGitOptions,
	StatusResult,
} from 'simple-git';
import { simpleGit } from 'simple-git';

import {
	SOURCE_CONTROL_ORIGIN,
	SOURCE_CONTROL_SSH_KEY_NAME,
	SOURCE_CONTROL_SSH_KEYS_DB_KEY,
} from './constants';
import { isValidGitBranchName } from './source-control-helper';
import type { SourceControlPreferences } from './types/source-control-preferences';

/** Quote a path for use inside the shell-parsed `GIT_SSH_COMMAND`. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

interface StoredKeyPair {
	encryptedPrivateKey: string;
	publicKey: string;
}

/**
 * Thin wrapper around `simple-git`, scoped to the source-control work folder.
 * Owns process-level git concerns — SSH command construction from the
 * database-stored key pair, remote/branch management, staging, committing —
 * while all content decisions (what to export/import) stay in the
 * export/import/status services.
 */
@Service()
export class SourceControlGitService {
	git: SimpleGit | null = null;

	private gitOptions: Partial<SimpleGitOptions> = {};

	constructor(
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly settingsRepository: SettingsRepository,
	) {
		this.logger = this.logger.scoped('source-control');
	}

	/**
	 * Initialize the underlying git client for the given work folder. Must be
	 * called before any other operation; safe to call repeatedly (e.g. after a
	 * preferences reload).
	 */
	async initService(options: {
		sourceControlPreferences: SourceControlPreferences;
		gitFolder: string;
		sshFolder: string;
	}): Promise<void> {
		const { sourceControlPreferences, gitFolder, sshFolder } = options;

		await mkdir(gitFolder, { recursive: true });
		await mkdir(sshFolder, { recursive: true });

		this.gitOptions = {
			baseDir: gitFolder,
			binary: 'git',
			maxConcurrentProcesses: 6,
			trimmed: false,
		};
		this.git = simpleGit(this.gitOptions);

		// HTTPS remotes authenticate via the URL itself; SSH remotes need the
		// instance key pair wired into GIT_SSH_COMMAND.
		if (!sourceControlPreferences.repositoryUrl.startsWith('http')) {
			await this.setGitSshCommand(sshFolder);
		}
	}

	/** Drop the git client, forcing a re-`initService` before further use. */
	resetService(): void {
		this.git = null;
		this.gitOptions = {};
	}

	private getGit(): SimpleGit {
		if (!this.git) {
			throw new UnexpectedError(
				'Git service is not initialized. Call `initService` before using it.',
			);
		}
		return this.git;
	}

	/**
	 * Materialize the database-stored private key into the SSH folder and point
	 * GIT_SSH_COMMAND at it. Host keys are recorded in a per-instance
	 * `known_hosts` (accepted on first use, verified thereafter). The rest of the
	 * process environment is preserved so proxy settings keep working.
	 */
	async setGitSshCommand(sshFolder: string): Promise<void> {
		const privateKeyPath = await this.writePrivateKeyToDisk(sshFolder);
		const knownHostsPath = path.join(sshFolder, 'known_hosts');
		await writeFile(knownHostsPath, '', { encoding: 'utf8', flag: 'a' });

		// Paths are shell-quoted (GIT_SSH_COMMAND is parsed by a shell) and
		// IdentitiesOnly pins authentication to the instance key so agent keys
		// can neither be exhausted nor substituted.
		const sshCommand = `ssh -o UserKnownHostsFile=${shellQuote(knownHostsPath)} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i ${shellQuote(privateKeyPath)}`;

		this.getGit().env({ ...process.env, GIT_SSH_COMMAND: sshCommand });
	}

	private async writePrivateKeyToDisk(sshFolder: string): Promise<string> {
		const keyPairRow = await this.settingsRepository.findByKey(SOURCE_CONTROL_SSH_KEYS_DB_KEY);
		if (!keyPairRow?.value) {
			throw new UserError(
				'No SSH key pair is configured for source control. Generate a key pair first.',
			);
		}
		const keyPair = jsonParse<StoredKeyPair | null>(keyPairRow.value, { fallbackValue: null });
		if (!keyPair?.encryptedPrivateKey) {
			throw new UnexpectedError('Stored source-control SSH key pair is malformed');
		}

		const privateKey = this.cipher.decryptWithInstanceKey(keyPair.encryptedPrivateKey);
		const privateKeyPath = path.join(sshFolder, SOURCE_CONTROL_SSH_KEY_NAME);
		// OpenSSH refuses group/world-readable identity files. The `mode` option
		// only applies on creation, so re-tighten an existing file explicitly.
		await writeFile(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
		await chmod(privateKeyPath, 0o600);
		return privateKeyPath;
	}

	async checkRepositorySetup(): Promise<boolean> {
		try {
			return await this.getGit().checkIsRepo();
		} catch {
			return false;
		}
	}

	/** Initialize the work folder as a repository tracking the configured remote. */
	async initRepository(
		sourceControlPreferences: Pick<SourceControlPreferences, 'repositoryUrl' | 'branchName'>,
		user: Pick<User, 'firstName' | 'lastName' | 'email'>,
	): Promise<void> {
		const git = this.getGit();
		if (!(await this.checkRepositorySetup())) {
			await git.init();
		}

		const remotes = await git.getRemotes(true);
		const origin = remotes.find((remote) => remote.name === SOURCE_CONTROL_ORIGIN);
		if (!origin) {
			await git.addRemote(SOURCE_CONTROL_ORIGIN, sourceControlPreferences.repositoryUrl);
		} else if (origin.refs.fetch !== sourceControlPreferences.repositoryUrl) {
			await git.remote(['set-url', SOURCE_CONTROL_ORIGIN, sourceControlPreferences.repositoryUrl]);
		}

		const name = `${user.firstName} ${user.lastName}`.trim() || 'n8n';
		await this.setGitUserDetails(name, user.email);
	}

	async setGitUserDetails(name: string, email: string): Promise<void> {
		const git = this.getGit();
		await git.addConfig('user.name', name);
		await git.addConfig('user.email', email);
	}

	async fetch(): Promise<FetchResult> {
		try {
			return await this.getGit().fetch();
		} catch (error) {
			throw new OperationalError(`Failed to fetch from remote: ${ensureError(error).message}`);
		}
	}

	async getBranches(): Promise<{ branches: string[]; currentBranch: string }> {
		const git = this.getGit();
		try {
			const remoteBranches = await git.branch(['-r']);
			const branches = remoteBranches.all
				.map((name) => name.split('/').slice(1).join('/'))
				.filter((name) => name !== 'HEAD');
			return { branches, currentBranch: await this.currentBranchName() };
		} catch (error) {
			throw new OperationalError(`Failed to list branches: ${ensureError(error).message}`);
		}
	}

	/** Check out `branch` (creating a local tracking branch as needed). */
	async setBranch(branch: string): Promise<{ branches: string[]; currentBranch: string }> {
		// Defense in depth: the controller validates user input, but nothing that
		// is not a plain branch name may ever reach `git checkout`.
		if (!isValidGitBranchName(branch)) {
			throw new UserError(`Invalid branch name: ${JSON.stringify(branch)}`);
		}
		const git = this.getGit();
		try {
			await git.checkout(branch);
		} catch {
			// Neither a local nor a remote-tracking ref exists yet (fresh repo).
			await git.checkoutLocalBranch(branch);
		}
		try {
			await git.branch([`--set-upstream-to=${SOURCE_CONTROL_ORIGIN}/${branch}`, branch]);
		} catch {
			this.logger.debug(`No upstream ${SOURCE_CONTROL_ORIGIN}/${branch} to track yet`);
		}
		return await this.getBranches();
	}

	private async currentBranchName(): Promise<string> {
		const git = this.getGit();
		const { current } = await git.branchLocal();
		if (current) return current;
		// A repo without commits has an unborn current branch that `git branch`
		// does not list; resolve it from HEAD instead.
		try {
			return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
		} catch {
			return '';
		}
	}

	async getCurrentBranch(): Promise<{ current: string; remote: string }> {
		const current = await this.currentBranchName();
		return { current, remote: `${SOURCE_CONTROL_ORIGIN}/${current}` };
	}

	/** Changes present on the remote branch that the local branch lacks. */
	async diffRemote(): Promise<DiffResult | undefined> {
		const { current, remote } = await this.getCurrentBranch();
		if (!current) return undefined;
		return await this.getGit().diffSummary([`${current}...${remote}`]);
	}

	/** Local changes not yet on the remote branch. */
	async diffLocal(): Promise<DiffResult | undefined> {
		const { current, remote } = await this.getCurrentBranch();
		if (!current) return undefined;
		return await this.getGit().diffSummary([`${remote}...${current}`]);
	}

	async pull(options: { ffOnly?: boolean } = {}): Promise<PullResult> {
		const params: Record<string, null> = {};
		// Fast-forward only by default: merge commits inside the work folder are
		// never wanted — conflicts are resolved by force-resetting instead.
		if (options.ffOnly !== false) params['--ff-only'] = null;
		try {
			// Explicit remote/branch keeps pull working even before upstream
			// tracking is configured (fresh clone/connect).
			const { current } = await this.getCurrentBranch();
			return await this.getGit().pull(SOURCE_CONTROL_ORIGIN, current, params);
		} catch (error) {
			throw new OperationalError(`Failed to pull from remote: ${ensureError(error).message}`);
		}
	}

	async push(options: { force?: boolean; branch: string }): Promise<PushResult> {
		// `-u` establishes upstream tracking on the first push.
		const pushOptions = options.force ? ['-u', '-f'] : ['-u'];
		try {
			return await this.getGit().push(SOURCE_CONTROL_ORIGIN, options.branch, pushOptions);
		} catch (error) {
			throw new OperationalError(`Failed to push to remote: ${ensureError(error).message}`);
		}
	}

	/** Stage the given files, removing `deletedFiles` from the index first. */
	async stage(files: Set<string>, deletedFiles?: Set<string>): Promise<string> {
		const git = this.getGit();
		for (const file of deletedFiles ?? []) {
			try {
				await git.rm(file);
			} catch {
				this.logger.debug(`File to delete not tracked by git, skipping: ${file}`);
			}
		}
		return await git.add(Array.from(files));
	}

	async commit(message: string): Promise<CommitResult> {
		return await this.getGit().commit(message);
	}

	async status(): Promise<StatusResult> {
		return await this.getGit().status();
	}

	/** Discard local state, resetting the work folder to the remote branch. */
	async resetBranch(options: { hard?: boolean; target?: string } = {}): Promise<void> {
		const git = this.getGit();
		const target = options.target ?? (await this.getCurrentBranch()).remote;
		await git.raw(['reset', options.hard === false ? '--soft' : '--hard', target]);
	}

	/**
	 * Remove untracked files/directories under the given managed paths —
	 * leftovers of failed or aborted exports that `reset --hard` cannot touch.
	 */
	async cleanManagedPaths(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		try {
			await this.getGit().raw(['clean', '-f', '-d', '--', ...paths]);
		} catch (error) {
			throw new OperationalError(`Failed to clean work folder: ${ensureError(error).message}`);
		}
	}
}
