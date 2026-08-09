import type {
	GitCommitInfo,
	PullWorkFolderRequestDto,
	PushWorkFolderRequestDto,
	SourceControlledFile,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { SettingsRepository, SharedWorkflowRepository, WorkflowRepository } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { hasGlobalScope } from '@n8n/permissions';
import { Cipher, InstanceSettings } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	SOURCE_CONTROL_DEFAULT_BRANCH,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_MANAGED_PATHS,
	SOURCE_CONTROL_SSH_FOLDER,
	SOURCE_CONTROL_SSH_KEYS_DB_KEY,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import type { SourceControlContext } from './source-control-context.factory';
import { SourceControlContextFactory } from './source-control-context.factory';
import { SourceControlExportService } from './source-control-export.service';
import { SourceControlGitService } from './source-control-git.service';
import {
	assertNotSymlink,
	assertParentWithinFolder,
	getTrackingInformationFromPullResult,
	isSafePathSegmentId,
	isSourceControlLicensed,
} from './source-control-helper';
import { SourceControlImportService } from './source-control-import.service';
import { SourceControlPreferencesService } from './source-control-preferences.service';
import { SourceControlScopedService } from './source-control-scoped.service';
import type { SourceControlGetStatusOptions } from './source-control-status.service';
import { SourceControlStatusService } from './source-control-status.service';
import type { RemoteResourceOwner } from './types/resource-owner';
import type { SourceControlPreferences } from './types/source-control-preferences';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EventService } from '@/events/event.service';

export interface SourceControlPushResult {
	statusResult: SourceControlledFile[];
	commit: GitCommitInfo | null;
}

export interface SourceControlPullResult {
	statusCode: number;
	statusResult: SourceControlledFile[];
}

export type SourceControlKeyGeneratorType = 'rsa' | 'ed25519';

interface StoredKeyPair {
	encryptedPrivateKey: string;
	publicKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resource types the caller must own (project-scoped) to include in a push. */
const OWNER_VALIDATED_TYPES: ReadonlySet<SourceControlledFile['type']> = new Set([
	'workflow',
	'credential',
	'datatable',
	'project',
]);

/**
 * Orchestrates the source-control feature: connect/disconnect, branch and key
 * management, and the push/pull/status flows that tie the git wrapper to the
 * export/import/status services. Authorization model: global
 * `sourceControl:pull` gates pulls and pull-status; pushes accept global or
 * project-level `sourceControl:push`, with per-candidate ownership checks for
 * project-scoped callers.
 */
@Service()
export class SourceControlService {
	private readonly gitFolder: string;

	private readonly sshFolder: string;

	/**
	 * Serializes workfolder-mutating operations (status-with-reset, push, pull,
	 * connect, disconnect, reset) within this process, so a reset can never run
	 * mid-export and concurrent pushes cannot mix commits. Cluster-wide (multi-
	 * main) locking is a documented follow-up.
	 */
	private operationQueue: Promise<unknown> = Promise.resolve();

	constructor(
		// Kept as raw (unscoped) logger: tests construct this service with a
		// shallow mock whose `.scoped()` returns undefined.
		private readonly logger: Logger,
		private readonly gitService: SourceControlGitService,
		private readonly sourceControlPreferencesService: SourceControlPreferencesService,
		private readonly sourceControlExportService: SourceControlExportService,
		private readonly sourceControlImportService: SourceControlImportService,
		private readonly sourceControlContextFactory: SourceControlContextFactory,
		private readonly sourceControlScopedService: SourceControlScopedService,
		private readonly eventService: EventService,
		private readonly sourceControlStatusService: SourceControlStatusService,
	) {
		const { n8nFolder } = Container.get(InstanceSettings);
		this.gitFolder = path.join(n8nFolder, SOURCE_CONTROL_GIT_FOLDER);
		this.sshFolder = path.join(n8nFolder, SOURCE_CONTROL_SSH_FOLDER);
	}

	/**
	 * Verify the feature is usable before any git/content operation: licensed,
	 * connected, and the git client ready. Tests stub this to bypass git.
	 */
	async sanityCheck(): Promise<void> {
		if (!isSourceControlLicensed()) {
			throw new BadRequestError('Source control is not licensed');
		}
		if (!this.sourceControlPreferencesService.isSourceControlConnected()) {
			throw new BadRequestError('Source control is not connected to a repository');
		}
		await this.ensureGitService();
		if (!(await this.gitService.checkRepositorySetup())) {
			throw new BadRequestError('Source control repository is not initialized');
		}
	}

	/** Run `operation` once all previously queued workfolder operations settled. */
	private async withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.operationQueue.then(operation, operation);
		this.operationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return await run;
	}

	@OnPubSubEvent('reload-source-control-config')
	async reloadConfiguration(): Promise<void> {
		await this.sourceControlPreferencesService.loadFromDbAndApplySourceControlPreferences();
		// Drop the git client so the next operation re-initializes it with the
		// fresh preferences and key material.
		this.gitService.resetService();
	}

	// ----------------------------------
	//              status
	// ----------------------------------

	async getStatus(
		user: User,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		// Locked: status hard-resets the work folder and must not run mid-push/pull.
		return await this.withOperationLock(async () => {
			await this.sanityCheck();
			const context = await this.sourceControlContextFactory.createContext(user);
			this.assertDirectionAccess(user, context, options.direction);
			return await this.sourceControlStatusService.getStatus(user, options);
		});
	}

	private assertDirectionAccess(
		user: User,
		context: SourceControlContext,
		direction: 'push' | 'pull',
	): void {
		if (direction === 'pull') {
			// Pulling applies remote state instance-wide, so project-level push
			// authority is insufficient.
			if (!hasGlobalScope(user, 'sourceControl:pull')) {
				throw new ForbiddenError('You do not have permission to pull from source control');
			}
			return;
		}
		if (!context.hasAnyAccess()) {
			throw new ForbiddenError('You do not have permission to push to source control');
		}
	}

	// ----------------------------------
	//               push
	// ----------------------------------

	async pushWorkfolder(
		user: User,
		payload: PushWorkFolderRequestDto,
	): Promise<SourceControlPushResult> {
		return await this.withOperationLock(async () => await this.pushWorkfolderLocked(user, payload));
	}

	private async pushWorkfolderLocked(
		user: User,
		payload: PushWorkFolderRequestDto,
	): Promise<SourceControlPushResult> {
		await this.sanityCheck();

		const preferences = this.sourceControlPreferencesService.getPreferences();
		// Read-only wins over authorization: even privileged callers may not
		// push onto a protected branch.
		if (preferences.branchReadOnly) {
			throw new BadRequestError('Cannot push onto read-only branch');
		}

		const context = await this.sourceControlContextFactory.createContext(user);
		if (!context.hasAnyAccess()) {
			throw new ForbiddenError('You do not have permission to push to source control');
		}

		// The request's fileNames are treated as *selections* only. All statuses,
		// owners, and filesystem paths come from a freshly computed scoped status,
		// so forged entries can neither smuggle out-of-scope resources nor make
		// arbitrary paths reach fs/git operations. An empty selection means "push
		// all current changes".
		const freshStatus = await this.sourceControlStatusService.getStatus(user, {
			direction: 'push',
			preferLocalVersion: true,
			verbose: false,
		});
		const candidates =
			payload.fileNames.length > 0
				? this.resolveCandidateSelection(payload.fileNames, freshStatus)
				: freshStatus;
		this.validateCandidateScope(context, candidates);

		this.eventService.emit('source-control-user-started-push-ui', {
			userId: user.id,
			workflowsEligible: candidates.filter((file) => file.type === 'workflow').length,
			workflowsEligibleWithConflicts: candidates.filter(
				(file) => file.type === 'workflow' && file.conflict,
			).length,
			credsEligible: candidates.filter((file) => file.type === 'credential').length,
			credsEligibleWithConflicts: candidates.filter(
				(file) => file.type === 'credential' && file.conflict,
			).length,
			variablesEligible: 0,
		});

		const writtenFiles = await this.exportCandidates(context, candidates);

		const deletedFiles = new Set(
			candidates.filter((file) => file.status === 'deleted').map((file) => file.file),
		);
		await this.gitService.stage(new Set(writtenFiles), deletedFiles);

		const commitResult = await this.gitService.commit(
			payload.commitMessage ?? 'Updated workfolder',
		);
		await this.gitService.push({
			branch: preferences.branchName || SOURCE_CONTROL_DEFAULT_BRANCH,
			force: payload.force ?? false,
		});

		const workflowsPushed = candidates.filter(
			(file) => file.type === 'workflow' && file.status !== 'deleted',
		).length;
		this.eventService.emit('source-control-user-finished-push-ui', {
			userId: user.id,
			workflowsEligible: candidates.filter((file) => file.type === 'workflow').length,
			workflowsPushed,
			credsPushed: candidates.filter(
				(file) => file.type === 'credential' && file.status !== 'deleted',
			).length,
			variablesPushed: 0,
		});

		const commit: GitCommitInfo | null = commitResult?.commit
			? {
					hash: commitResult.commit,
					message: payload.commitMessage ?? 'Updated workfolder',
					branch: preferences.branchName || SOURCE_CONTROL_DEFAULT_BRANCH,
				}
			: null;

		return { statusResult: candidates, commit };
	}

	/**
	 * Map requested `{type, id}` selections onto the freshly computed status.
	 * Every returned entry is the server-side one — client-supplied paths,
	 * statuses, and owners are discarded. A selection that is not part of the
	 * fresh scoped status is rejected (out of scope, nonexistent, or forged);
	 * only the aggregate types, which carry no per-resource data, are skipped
	 * silently when they have nothing to push.
	 */
	private resolveCandidateSelection(
		requested: SourceControlledFile[],
		freshStatus: SourceControlledFile[],
	): SourceControlledFile[] {
		const freshByKey = new Map(freshStatus.map((file) => [`${file.type}:${file.id}`, file]));
		const selected = new Map<string, SourceControlledFile>();
		for (const request of requested) {
			const key = `${request.type}:${request.id}`;
			const fresh = freshByKey.get(key);
			if (!fresh) {
				if (request.type === 'tags' || request.type === 'folders') continue;
				throw new ForbiddenError(
					`You do not have permission to push ${request.type} "${request.id}"`,
				);
			}
			selected.set(key, fresh);
		}
		return [...selected.values()];
	}

	/**
	 * A project-scoped caller may only push resources owned by their authorized
	 * team projects. Aggregate files (tags, folders) are always allowed — their
	 * export merges and never touches out-of-scope entries.
	 */
	private validateCandidateScope(
		context: SourceControlContext,
		candidates: SourceControlledFile[],
	): void {
		if (context.hasAccessToAllProjects()) return;
		for (const candidate of candidates) {
			if (!OWNER_VALIDATED_TYPES.has(candidate.type)) continue;
			const owner = candidate.owner;
			if (!owner || owner.type !== 'team' || !context.hasAccessToProject(owner.projectId)) {
				throw new ForbiddenError(
					`You do not have permission to push ${candidate.type} "${candidate.name}"`,
				);
			}
		}
	}

	private async exportCandidates(
		context: SourceControlContext,
		candidates: SourceControlledFile[],
	): Promise<string[]> {
		const nonDeleted = (type: SourceControlledFile['type']) =>
			candidates.filter((file) => file.type === type && file.status !== 'deleted');

		const writtenFiles: string[] = [];

		const workflowCandidates = nonDeleted('workflow');
		if (workflowCandidates.length > 0) {
			const result =
				await this.sourceControlExportService.exportWorkflowsToWorkFolder(workflowCandidates);
			writtenFiles.push(...result.files);
		}

		const credentialCandidates = nonDeleted('credential');
		if (credentialCandidates.length > 0) {
			const result =
				await this.sourceControlExportService.exportCredentialsToWorkFolder(credentialCandidates);
			writtenFiles.push(...result.files);
		}

		const dataTableCandidates = nonDeleted('datatable');
		if (dataTableCandidates.length > 0) {
			const result =
				await this.sourceControlExportService.exportDataTablesToWorkFolder(dataTableCandidates);
			writtenFiles.push(...result.files);
		}

		if (candidates.some((file) => file.type === 'folders')) {
			const result = await this.sourceControlExportService.exportFoldersToWorkFolder(context);
			writtenFiles.push(...result.files);
		}

		if (candidates.some((file) => file.type === 'tags')) {
			const result = await this.sourceControlExportService.exportTagsToWorkFolder(context);
			writtenFiles.push(...result.files);
		}

		writtenFiles.push(...(await this.exportProjects(nonDeleted('project'))));

		return writtenFiles;
	}

	/**
	 * Serialize the owning team projects selected for this push. Project files
	 * are synthesized from the status entries (`projects/<id>.json`); their
	 * exact shape has no surviving pin, so only identifying fields are written.
	 * Paths are rebuilt from the canonical builder — never taken from entries.
	 */
	private async exportProjects(candidates: SourceControlledFile[]): Promise<string[]> {
		if (candidates.length === 0) return [];

		const files: string[] = [];
		for (const candidate of candidates) {
			if (!isSafePathSegmentId(candidate.id)) {
				this.logger.warn(`Skipping project export for unsafe id ${JSON.stringify(candidate.id)}`);
				continue;
			}
			const filePath = this.sourceControlStatusService.getProjectPath(candidate.id);
			await mkdir(path.dirname(filePath), { recursive: true });
			await assertNotSymlink(filePath);
			const content = { id: candidate.id, name: candidate.name, type: 'team' };
			await writeFile(filePath, JSON.stringify(content, null, 2));
			files.push(filePath);
		}
		return files;
	}

	// ----------------------------------
	//               pull
	// ----------------------------------

	async pullWorkfolder(
		user: User,
		payload: PullWorkFolderRequestDto,
	): Promise<SourceControlPullResult> {
		return await this.withOperationLock(async () => await this.pullWorkfolderLocked(user, payload));
	}

	private async pullWorkfolderLocked(
		user: User,
		payload: PullWorkFolderRequestDto,
	): Promise<SourceControlPullResult> {
		await this.sanityCheck();

		if (!hasGlobalScope(user, 'sourceControl:pull')) {
			throw new ForbiddenError('You do not have permission to pull from source control');
		}

		// Fail closed: a pull must apply the current remote state or nothing. A
		// failing fetch/reset propagates (as OperationalError from the git
		// service) instead of silently importing stale or dirty content.
		await this.gitService.fetch();
		await this.gitService.resetBranch({ hard: true });
		await this.gitService.cleanManagedPaths([...SOURCE_CONTROL_MANAGED_PATHS]);

		const statusResult = await this.sourceControlStatusService.getStatus(user, {
			direction: 'pull',
			preferLocalVersion: false,
			verbose: false,
		});

		this.eventService.emit('source-control-user-started-pull-ui', {
			...getTrackingInformationFromPullResult(user.id, statusResult),
		});

		// Without force, local changes that the pull would overwrite are
		// reported back instead of being applied.
		const conflicts = statusResult.filter((file) => file.conflict);
		if (conflicts.length > 0 && payload.force !== true) {
			return { statusCode: 409, statusResult };
		}

		const importable = (type: SourceControlledFile['type']) =>
			statusResult.filter((file) => file.type === type && file.status !== 'deleted');
		const deletable = (type: SourceControlledFile['type']) =>
			statusResult.filter((file) => file.type === type && file.status === 'deleted');

		// Folders first so imported workflows can attach to their parent folders.
		if (statusResult.some((file) => file.type === 'folders' && file.status !== 'deleted')) {
			await this.sourceControlImportService.importFoldersFromWorkFolder(user);
		}

		const dataTableCandidates = importable('datatable');
		if (dataTableCandidates.length > 0) {
			await this.sourceControlImportService.importDataTablesFromWorkFolder(
				dataTableCandidates,
				user.id,
			);
		}

		const credentialCandidates = importable('credential');
		if (credentialCandidates.length > 0) {
			await this.sourceControlImportService.importCredentialsFromWorkFolder(
				credentialCandidates,
				user.id,
			);
		}

		const workflowCandidates = importable('workflow');
		if (workflowCandidates.length > 0) {
			await this.sourceControlImportService.importWorkflowFromWorkFolder(
				workflowCandidates,
				user.id,
			);
		}

		// A `created` tags entry means the remote file does not exist (local tags
		// only) — there is nothing to read or import in that case.
		const tagsCandidate = statusResult.find((file) => file.type === 'tags');
		if (tagsCandidate && tagsCandidate.status !== 'created') {
			await this.sourceControlImportService.importTagsFromWorkFolder(tagsCandidate, user);
		}

		// Apply remote deletions last, so nothing just imported depends on a row
		// that is about to disappear. Status entries are already scope-filtered:
		// only in-scope resources can be deleted.
		await this.sourceControlImportService.deleteWorkflowsRemovedFromRemote(
			user,
			deletable('workflow'),
		);
		await this.sourceControlImportService.deleteCredentialsRemovedFromRemote(
			user,
			deletable('credential'),
		);
		await this.sourceControlImportService.deleteFoldersRemovedFromRemote(
			user,
			deletable('folders'),
		);
		await this.sourceControlImportService.deleteDataTablesRemovedFromRemote(deletable('datatable'));

		this.eventService.emit('source-control-user-finished-pull-ui', {
			userId: user.id,
			workflowUpdates: workflowCandidates.length,
		});

		return { statusCode: 200, statusResult };
	}

	// ----------------------------------
	//        connect / branches
	// ----------------------------------

	async getBranches(): Promise<{ branches: string[]; currentBranch: string }> {
		await this.ensureGitService();
		return await this.gitService.getBranches();
	}

	async setBranch(branchName: string): Promise<{ branches: string[]; currentBranch: string }> {
		await this.ensureGitService();
		const result = await this.gitService.setBranch(branchName);
		await this.sourceControlPreferencesService.setPreferences({ branchName });
		return result;
	}

	/**
	 * Connect the instance to the configured repository: initialize the local
	 * repo, discover remote branches, and check out the configured branch
	 * (falling back to `main`, then the first remote branch).
	 */
	async connect(user: User): Promise<SourceControlPreferences> {
		return await this.withOperationLock(async () => {
			const preferences = this.sourceControlPreferencesService.getPreferences();
			if (!preferences.repositoryUrl) {
				throw new BadRequestError('Cannot connect: no repository URL is configured');
			}

			this.gitService.resetService();
			await this.ensureGitService();
			await this.gitService.initRepository(
				{
					repositoryUrl: preferences.repositoryUrl,
					branchName: preferences.branchName || SOURCE_CONTROL_DEFAULT_BRANCH,
				},
				user,
			);

			// The remote must be verified before `connected` is persisted: a
			// failing fetch propagates instead of connecting to an unreachable or
			// invalid repository.
			await this.gitService.fetch();

			const { branches } = await this.gitService.getBranches();
			// A configured branch must exist on the remote (an empty remote is
			// fine — it is the initial-setup case and branches are created on the
			// first push).
			if (
				preferences.branchName &&
				branches.length > 0 &&
				!branches.includes(preferences.branchName)
			) {
				throw new BadRequestError(
					`Branch "${preferences.branchName}" does not exist on the remote`,
				);
			}
			const branchName =
				preferences.branchName ||
				(branches.includes(SOURCE_CONTROL_DEFAULT_BRANCH)
					? SOURCE_CONTROL_DEFAULT_BRANCH
					: (branches[0] ?? SOURCE_CONTROL_DEFAULT_BRANCH));
			await this.gitService.setBranch(branchName);

			return await this.sourceControlPreferencesService.setPreferences({
				connected: true,
				branchName,
			});
		});
	}

	async disconnect(options: { keepKeyPair?: boolean }): Promise<SourceControlPreferences> {
		return await this.withOperationLock(async () => {
			const preferences = await this.sourceControlPreferencesService.setPreferences({
				connected: false,
				branchName: '',
			});
			// keepKeyPair defaults to true: deleting the deploy key is the
			// irreversible action and must be requested explicitly.
			if (options.keepKeyPair === false) {
				await Container.get(SettingsRepository).deleteByKey(SOURCE_CONTROL_SSH_KEYS_DB_KEY);
			}
			this.gitService.resetService();
			return preferences;
		});
	}

	async resetWorkfolder(): Promise<void> {
		await this.withOperationLock(async () => {
			await this.sanityCheck();
			await this.gitService.fetch();
			await this.gitService.resetBranch({ hard: true });
			// `reset --hard` cannot remove untracked leftovers of failed exports.
			await this.gitService.cleanManagedPaths([...SOURCE_CONTROL_MANAGED_PATHS]);
		});
	}

	// ----------------------------------
	//           key management
	// ----------------------------------

	/** The stored public key, or `null` when none exists. Never generates keys. */
	async getStoredPublicKey(): Promise<string | null> {
		return (await this.getStoredKeyPair())?.publicKey ?? null;
	}

	/** The instance public key, generating and storing a key pair when absent. */
	async getPublicKey(): Promise<string> {
		const stored = await this.getStoredKeyPair();
		if (stored) return stored.publicKey;
		const { keyGeneratorType } = this.sourceControlPreferencesService.getPreferences();
		const generated = await this.generateAndSaveKeyPair(keyGeneratorType);
		return generated.publicKey;
	}

	async generateAndSaveKeyPair(
		keyGeneratorType?: SourceControlKeyGeneratorType,
	): Promise<{ publicKey: string; keyGeneratorType: SourceControlKeyGeneratorType }> {
		const type =
			keyGeneratorType ??
			this.sourceControlPreferencesService.getPreferences().keyGeneratorType ??
			'rsa';
		const { privateKey, publicKey } = await this.createKeyPair(type);

		const stored: StoredKeyPair = {
			encryptedPrivateKey: Container.get(Cipher).encryptWithInstanceKey(privateKey),
			publicKey,
		};
		await Container.get(SettingsRepository).upsertByKey(
			SOURCE_CONTROL_SSH_KEYS_DB_KEY,
			JSON.stringify(stored),
			false,
			{},
		);
		await this.sourceControlPreferencesService.setPreferences({ keyGeneratorType: type });
		// The cached SSH command points at the previous key; force re-init.
		this.gitService.resetService();

		return { publicKey, keyGeneratorType: type };
	}

	private async getStoredKeyPair(): Promise<StoredKeyPair | null> {
		const row = await Container.get(SettingsRepository).findByKey(SOURCE_CONTROL_SSH_KEYS_DB_KEY);
		if (!row?.value) return null;
		const parsed = jsonParse<StoredKeyPair | null>(row.value, { fallbackValue: null });
		return parsed?.publicKey && parsed.encryptedPrivateKey ? parsed : null;
	}

	private async createKeyPair(
		type: SourceControlKeyGeneratorType,
	): Promise<{ privateKey: string; publicKey: string }> {
		// sshpk is only needed for key generation; keep it off the request path.
		const { default: sshpk } = await import('sshpk');

		if (type === 'ed25519') {
			const key = sshpk.generatePrivateKey('ed25519');
			key.comment = 'n8n deploy key';
			return {
				privateKey: key.toString('openssh'),
				publicKey: key.toPublic().toString('ssh'),
			};
		}

		const { generateKeyPair } = await import('node:crypto');
		const privateKeyPem = await new Promise<string>((resolve, reject) => {
			generateKeyPair(
				'rsa',
				{
					modulusLength: 4096,
					publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
					privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
				},
				(error, _publicKeyPem, generatedPrivateKeyPem) => {
					if (error) reject(error);
					else resolve(generatedPrivateKeyPem);
				},
			);
		});
		const parsed = sshpk.parsePrivateKey(privateKeyPem, 'pem');
		parsed.comment = 'n8n deploy key';
		return {
			privateKey: privateKeyPem,
			publicKey: parsed.toPublic().toString('ssh'),
		};
	}

	// ----------------------------------
	//           remote content
	// ----------------------------------

	/**
	 * Read a resource file from the work folder, applying context-aware
	 * authorization. Only reads from within the work directory, and authorizes
	 * scoped callers against the *remote* file's serialized owner (with the
	 * local ownership, when the resource exists locally, as an additional
	 * constraint) — never against a client-claimed owner.
	 */
	async getRemoteFileEntity(options: {
		user: User;
		type: string;
		id: string;
	}): Promise<{ content: unknown }> {
		await this.sanityCheck();

		if (options.type !== 'workflow') {
			throw new BadRequestError(`Unsupported remote content type: ${options.type}`);
		}

		// The id is caller-controlled; it must be a plain path segment.
		if (!isSafePathSegmentId(options.id)) {
			throw new BadRequestError('Invalid remote content id');
		}

		const context = await this.sourceControlContextFactory.createContext(options.user);
		if (!context.hasAnyAccess()) {
			throw new ForbiddenError('You do not have permission to view this workflow');
		}

		const fileName = `${options.id}.json`;
		const filePath = path.join(this.gitFolder, SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER, fileName);
		if (path.basename(filePath) !== fileName || !filePath.startsWith(this.gitFolder + path.sep)) {
			throw new BadRequestError('Invalid remote content id');
		}
		await assertNotSymlink(filePath);
		await assertParentWithinFolder(filePath, this.gitFolder);

		let content: unknown;
		try {
			content = jsonParse<unknown>((await readFile(filePath, { encoding: 'utf8' })).toString());
		} catch {
			throw new NotFoundError(`Remote ${options.type} "${options.id}" not found`);
		}

		if (!context.hasAccessToAllProjects()) {
			// Primary check: the remote file's own serialized owner must be one of
			// the caller's authorized team projects.
			const remoteOwner = this.parseRemoteOwner(content);
			if (
				!remoteOwner ||
				typeof remoteOwner === 'string' ||
				remoteOwner.type !== 'team' ||
				!context.hasAccessToProject(remoteOwner.teamId)
			) {
				throw new ForbiddenError('You do not have permission to view this workflow');
			}

			// Additional constraint: when the workflow exists locally, its local
			// ownership must also be in scope (mirrors the status scoping rules).
			const existsLocally =
				(await Container.get(WorkflowRepository).findByIds([options.id])).length > 0;
			if (existsLocally) {
				const projectIds = context.getAuthorizedProjectIds() ?? [];
				const accessibleIds =
					projectIds.length > 0
						? await Container.get(SharedWorkflowRepository).findWorkflowIdsOwnedByProjects(
								projectIds,
							)
						: [];
				if (!accessibleIds.includes(options.id)) {
					throw new ForbiddenError('You do not have permission to view this workflow');
				}
			}
		}

		return { content };
	}

	/** Extract and validate the serialized owner from a parsed remote resource file. */
	private parseRemoteOwner(content: unknown): RemoteResourceOwner | null {
		if (!isRecord(content)) return null;
		const owner: unknown = content.owner;
		if (typeof owner === 'string') return owner;
		if (!isRecord(owner)) return null;
		if (owner.type === 'team' && typeof owner.teamId === 'string') {
			return {
				type: 'team',
				teamId: owner.teamId,
				teamName: typeof owner.teamName === 'string' ? owner.teamName : '',
			};
		}
		if (owner.type === 'personal' && typeof owner.personalEmail === 'string') {
			return { type: 'personal', personalEmail: owner.personalEmail };
		}
		return null;
	}

	// ----------------------------------
	//             helpers
	// ----------------------------------

	private async ensureGitService(): Promise<void> {
		if (this.gitService.git) return;
		await this.gitService.initService({
			sourceControlPreferences: this.sourceControlPreferencesService.getPreferences(),
			gitFolder: this.gitFolder,
			sshFolder: this.sshFolder,
		});
	}

	/** Whether the user has any push authority (global or project-level). */
	async hasPushAuthority(user: User): Promise<boolean> {
		const projectIds = await this.sourceControlScopedService.getAuthorizedTeamProjectIds(user);
		return projectIds === null || projectIds.length > 0;
	}
}
