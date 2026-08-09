import type { SourceControlledFile } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { Project, User } from '@n8n/db';
import { CredentialsRepository, SharedWorkflowRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import glob from 'fast-glob';
import { InstanceSettings } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER,
	SOURCE_CONTROL_FOLDERS_EXPORT_FILE,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import type { SourceControlContext } from './source-control-context.factory';
import { SourceControlContextFactory } from './source-control-context.factory';
import type { TagsExportFile } from './source-control-export.service';
import { SourceControlGitService } from './source-control-git.service';
import type {
	RemoteCredentialFile,
	SourceControlCredentialListItem,
	SourceControlWorkflowVersionId,
} from './source-control-import.service';
import type { ExportableWorkflow } from './types/exportable-workflow';
import { SourceControlImportService } from './source-control-import.service';
import type { ExportableDataTable } from './types/exportable-data-table';
import type { ExportableFolder, FolderExportFile } from './types/exportable-folders';
import type { RemoteResourceOwner } from './types/resource-owner';

import type { DataTable } from '@/modules/data-table/data-table.entity';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';

export interface SourceControlGetStatusOptions {
	direction: 'push' | 'pull';
	preferLocalVersion: boolean;
	verbose: boolean;
}

type StatusOwner = NonNullable<SourceControlledFile['owner']>;

/**
 * A workflow file as read for status comparison. Unlike the import side's
 * discovery, a missing `versionId` does not exclude the file — a remote file
 * that can't be imported must still show up as a difference.
 */
interface RemoteWorkflowStatusItem {
	id: string;
	versionId?: string;
	filename: string;
	name?: string;
	parentFolderId: string | null;
	updatedAt?: string;
	owner?: RemoteResourceOwner;
}

/** Folder name inside the work folder holding one JSON file per team project. */
const SOURCE_CONTROL_PROJECT_EXPORT_FOLDER = 'projects';

/**
 * Computes the difference between the local instance and the source-control
 * work folder as a list of {@link SourceControlledFile} entries, restricted to
 * the caller's source-control scope.
 *
 * Direction semantics: `push` describes what pushing would do to the remote
 * (local-only → created, remote-only → deleted); `pull` describes what pulling
 * would do locally (remote-only → created, local-only → deleted). A resource
 * that differs on both sides is `modified`; in pull direction it is also
 * flagged as a conflict, since applying the remote version would overwrite
 * local changes.
 */
@Service()
export class SourceControlStatusService {
	private readonly gitFolder: string;

	constructor(
		private readonly logger: Logger,
		private readonly gitService: SourceControlGitService,
		private readonly contextFactory: SourceControlContextFactory,
		private readonly importService: SourceControlImportService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly dataTableRepository: DataTableRepository,
		instanceSettings: InstanceSettings,
	) {
		this.gitFolder = path.join(instanceSettings.n8nFolder, SOURCE_CONTROL_GIT_FOLDER);
		this.logger = this.logger.scoped('source-control');
	}

	getProjectPath(projectId: string): string {
		return path.join(this.gitFolder, SOURCE_CONTROL_PROJECT_EXPORT_FOLDER, `${projectId}.json`);
	}

	async getStatus(
		user: User,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const context = await this.contextFactory.createContext(user);

		await this.syncWorkfolder();

		const files: SourceControlledFile[] = [];
		files.push(...(await this.getWorkflowStatus(context, options)));
		files.push(...(await this.getCredentialStatus(context, options)));
		files.push(...(await this.getFolderStatus(context, options)));
		files.push(...(await this.getDataTableStatus(context, options)));
		files.push(...(await this.getTagsStatus(context, options)));
		files.push(...this.getProjectStatus(files, options));
		return files;
	}

	/**
	 * Bring the work folder in line with the remote branch so file comparisons
	 * reflect the remote state. Both steps are best-effort: a failing fetch
	 * (e.g. remote temporarily unreachable) must not break status computation.
	 */
	private async syncWorkfolder(): Promise<void> {
		try {
			await this.gitService.fetch();
		} catch (error) {
			this.logger.debug('Fetching from remote failed during status computation', { error });
		}
		try {
			await this.resetWorkfolder();
		} catch (error) {
			this.logger.debug('Resetting work folder failed during status computation', { error });
		}
	}

	private async resetWorkfolder(): Promise<void> {
		await this.gitService.resetBranch({ hard: true });
	}

	// ----------------------------------
	//            workflows
	// ----------------------------------

	private async getWorkflowStatus(
		context: SourceControlContext,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const remote = await this.readRemoteWorkflows(context);
		const local = await this.importService.getLocalVersionIdsFromDb(context);

		const localById = new Map(local.map((item) => [item.id, item]));
		const remoteById = new Map(remote.map((item) => [item.id, item]));
		const ownersById = await this.getLocalWorkflowOwners(local.map((item) => item.id));

		const files: SourceControlledFile[] = [];

		// Remote-only workflows. For a scoped caller a remote workflow may exist
		// locally in a project outside their scope — that is a move, not a
		// deletion, and must not be reported.
		const remoteOnly = remote.filter((item) => !localById.has(item.id));
		const locallyKnownIds = await this.findExistingWorkflowIds(
			context,
			remoteOnly.map((item) => item.id),
		);
		for (const item of remoteOnly) {
			if (locallyKnownIds.has(item.id)) continue;
			files.push(
				this.toStatusFile({
					type: 'workflow',
					id: item.id,
					name: item.name ?? item.id,
					file: item.filename,
					status: options.direction === 'push' ? 'deleted' : 'created',
					location: 'remote',
					updatedAt: item.updatedAt,
					owner: this.remoteOwnerToStatusOwner(item.owner),
				}),
			);
		}

		for (const item of local) {
			const remoteItem = remoteById.get(item.id);
			const owner = ownersById.get(item.id);
			if (!remoteItem) {
				files.push(
					this.toStatusFile({
						type: 'workflow',
						id: item.id,
						name: item.name ?? item.id,
						file: item.filename,
						status: options.direction === 'push' ? 'created' : 'deleted',
						location: 'local',
						updatedAt: item.updatedAt,
						owner,
					}),
				);
				continue;
			}

			if (!this.workflowsDiffer(item, remoteItem)) continue;

			const preferred = options.preferLocalVersion ? item : remoteItem;
			files.push(
				this.toStatusFile({
					type: 'workflow',
					id: item.id,
					name: preferred.name ?? item.id,
					file: preferred.filename,
					status: 'modified',
					location: options.preferLocalVersion ? 'local' : 'remote',
					conflict: options.direction === 'pull',
					updatedAt: preferred.updatedAt,
					owner,
				}),
			);
		}

		return files;
	}

	private workflowsDiffer(
		local: SourceControlWorkflowVersionId,
		remote: RemoteWorkflowStatusItem,
	): boolean {
		if (local.versionId !== remote.versionId) return true;
		if (remote.name !== undefined && local.name !== remote.name) return true;
		if ((local.parentFolderId ?? null) !== (remote.parentFolderId ?? null)) return true;
		return false;
	}

	private async readRemoteWorkflows(
		context: SourceControlContext,
	): Promise<RemoteWorkflowStatusItem[]> {
		if (!context.hasAnyAccess()) return [];

		const workflowFiles = await glob('*.json', {
			cwd: path.join(this.gitFolder, SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER),
			absolute: true,
		});

		const remote: RemoteWorkflowStatusItem[] = [];
		for (const file of workflowFiles) {
			const parsed = await this.readJsonFile<Partial<ExportableWorkflow> & { updatedAt?: string }>(
				file,
			);
			if (!parsed?.id) continue;
			if (!this.isRemoteOwnerInScope(context, parsed.owner)) continue;
			remote.push({
				id: parsed.id,
				versionId: parsed.versionId,
				filename: file,
				name: parsed.name,
				parentFolderId: parsed.parentFolderId ?? null,
				updatedAt: parsed.updatedAt,
				owner: parsed.owner,
			});
		}
		return remote;
	}

	private async getLocalWorkflowOwners(workflowIds: string[]): Promise<Map<string, StatusOwner>> {
		if (workflowIds.length === 0) return new Map();
		const sharings = await this.sharedWorkflowRepository.findByWorkflowIds(workflowIds);
		const owners = new Map<string, StatusOwner>();
		for (const sharing of sharings) {
			if (!sharing.project) continue;
			owners.set(sharing.workflowId, this.projectToStatusOwner(sharing.project));
		}
		return owners;
	}

	/** Of the given remote-only ids, which exist locally (in any project). */
	private async findExistingWorkflowIds(
		context: SourceControlContext,
		workflowIds: string[],
	): Promise<Set<string>> {
		// Instance-wide callers already saw every local workflow, so a remote-only
		// id is guaranteed absent locally.
		if (context.hasAccessToAllProjects() || workflowIds.length === 0) return new Set();
		const existing = await this.workflowRepository.findByIds(workflowIds);
		return new Set(existing.map((workflow) => workflow.id));
	}

	// ----------------------------------
	//            credentials
	// ----------------------------------

	private async getCredentialStatus(
		context: SourceControlContext,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const remote = await this.importService.getRemoteCredentialsFromFiles(context);
		const local = await this.importService.getLocalCredentialsFromDb(context);

		const localById = new Map(local.map((item) => [item.id, item]));
		const remoteById = new Map(remote.map((item) => [item.id, item]));

		const files: SourceControlledFile[] = [];

		const remoteOnly = remote.filter((item) => !localById.has(item.id));
		const locallyKnownIds = await this.findExistingCredentialIds(
			context,
			remoteOnly.map((item) => item.id),
		);
		for (const item of remoteOnly) {
			if (locallyKnownIds.has(item.id)) continue;
			files.push(
				this.toStatusFile({
					type: 'credential',
					id: item.id,
					name: item.name ?? item.id,
					file: item.filename,
					status: options.direction === 'push' ? 'deleted' : 'created',
					location: 'remote',
					owner: this.remoteOwnerToStatusOwner(item.ownedBy),
				}),
			);
		}

		for (const item of local) {
			const remoteItem = remoteById.get(item.id);
			const owner = this.remoteOwnerToStatusOwner(item.ownedBy);
			if (!remoteItem) {
				files.push(
					this.toStatusFile({
						type: 'credential',
						id: item.id,
						name: item.name,
						file: item.filename,
						status: options.direction === 'push' ? 'created' : 'deleted',
						location: 'local',
						owner,
					}),
				);
				continue;
			}

			if (!this.credentialsDiffer(item, remoteItem)) continue;

			files.push(
				this.toStatusFile({
					type: 'credential',
					id: item.id,
					name: item.name,
					file: options.preferLocalVersion ? item.filename : remoteItem.filename,
					status: 'modified',
					location: options.preferLocalVersion ? 'local' : 'remote',
					conflict: options.direction === 'pull',
					owner,
				}),
			);
		}

		return files;
	}

	private credentialsDiffer(
		local: SourceControlCredentialListItem,
		remote: RemoteCredentialFile,
	): boolean {
		if (remote.name !== undefined && local.name !== remote.name) return true;
		if (remote.type !== undefined && local.type !== remote.type) return true;
		// An absent isGlobal means false — the flag predates the export field.
		if ((local.isGlobal ?? false) !== (remote.isGlobal ?? false)) return true;
		return false;
	}

	private async findExistingCredentialIds(
		context: SourceControlContext,
		credentialIds: string[],
	): Promise<Set<string>> {
		if (context.hasAccessToAllProjects() || credentialIds.length === 0) return new Set();
		const existing = await this.credentialsRepository.getManyByIds(credentialIds);
		return new Set(existing.map((credential) => credential.id));
	}

	// ----------------------------------
	//             folders
	// ----------------------------------

	private async getFolderStatus(
		context: SourceControlContext,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const foldersFilePath = path.join(this.gitFolder, SOURCE_CONTROL_FOLDERS_EXPORT_FILE);
		const { folders: localFolders } =
			await this.importService.getLocalFoldersAndMappingsFromDb(context);
		const remoteFolders = (await this.readRemoteFolders()).filter((folder) =>
			context.hasAccessToProject(folder.homeProjectId),
		);

		const localById = new Map(localFolders.map((folder) => [folder.id, folder]));
		const remoteById = new Map(remoteFolders.map((folder) => [folder.id, folder]));

		const files: SourceControlledFile[] = [];

		for (const folder of remoteFolders) {
			if (localById.has(folder.id)) continue;
			files.push(
				this.toStatusFile({
					type: 'folders',
					id: folder.id,
					name: folder.name,
					file: foldersFilePath,
					status: options.direction === 'push' ? 'deleted' : 'created',
					location: 'remote',
					updatedAt: folder.updatedAt,
					owner: { type: 'team', projectId: folder.homeProjectId, projectName: '' },
				}),
			);
		}

		for (const folder of localFolders) {
			const remoteFolder = remoteById.get(folder.id);
			const owner: StatusOwner = {
				type: 'team',
				projectId: folder.homeProjectId,
				projectName: '',
			};
			if (!remoteFolder) {
				files.push(
					this.toStatusFile({
						type: 'folders',
						id: folder.id,
						name: folder.name,
						file: foldersFilePath,
						status: options.direction === 'push' ? 'created' : 'deleted',
						location: 'local',
						updatedAt: folder.updatedAt,
						owner,
					}),
				);
				continue;
			}

			const differs =
				folder.name !== remoteFolder.name ||
				(folder.parentFolderId ?? null) !== (remoteFolder.parentFolderId ?? null) ||
				folder.homeProjectId !== remoteFolder.homeProjectId;
			if (!differs) continue;

			files.push(
				this.toStatusFile({
					type: 'folders',
					id: folder.id,
					name: folder.name,
					file: foldersFilePath,
					status: 'modified',
					location: options.preferLocalVersion ? 'local' : 'remote',
					conflict: options.direction === 'pull',
					updatedAt: folder.updatedAt,
					owner,
				}),
			);
		}

		return files;
	}

	private async readRemoteFolders(): Promise<ExportableFolder[]> {
		const matches = await glob(SOURCE_CONTROL_FOLDERS_EXPORT_FILE, {
			cwd: this.gitFolder,
			absolute: true,
		});
		if (matches.length === 0) return [];
		const parsed = await this.readJsonFile<FolderExportFile>(matches[0]);
		return parsed?.folders ?? [];
	}

	// ----------------------------------
	//            data tables
	// ----------------------------------

	private async getDataTableStatus(
		context: SourceControlContext,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const local = await this.getLocalDataTables(context);
		const remote = (await this.readRemoteDataTables()).filter((item) =>
			this.isRemoteOwnerInScope(context, item.parsed.ownedBy),
		);

		const localById = new Map(local.map((dataTable) => [dataTable.id, dataTable]));
		const remoteById = new Map(remote.map((item) => [item.parsed.id, item]));

		const files: SourceControlledFile[] = [];

		const remoteOnly = remote.filter((item) => !localById.has(item.parsed.id));
		const locallyKnownIds = await this.findExistingDataTableIds(
			context,
			remoteOnly.map((item) => item.parsed.id),
		);
		for (const item of remoteOnly) {
			if (locallyKnownIds.has(item.parsed.id)) continue;
			files.push(
				this.toStatusFile({
					type: 'datatable',
					id: item.parsed.id,
					name: item.parsed.name,
					file: item.filename,
					status: options.direction === 'push' ? 'deleted' : 'created',
					location: 'remote',
					updatedAt: item.parsed.updatedAt,
					owner: this.remoteOwnerToStatusOwner(item.parsed.ownedBy),
				}),
			);
		}

		for (const dataTable of local) {
			const localFile = path.join(
				this.gitFolder,
				SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER,
				`${dataTable.id}.json`,
			);
			const owner = dataTable.project ? this.projectToStatusOwner(dataTable.project) : undefined;
			const remoteItem = remoteById.get(dataTable.id);
			if (!remoteItem) {
				files.push(
					this.toStatusFile({
						type: 'datatable',
						id: dataTable.id,
						name: dataTable.name,
						file: localFile,
						status: options.direction === 'push' ? 'created' : 'deleted',
						location: 'local',
						updatedAt: dataTable.updatedAt?.toISOString(),
						owner,
					}),
				);
				continue;
			}

			if (!this.dataTablesDiffer(dataTable, remoteItem.parsed)) continue;

			files.push(
				this.toStatusFile({
					type: 'datatable',
					id: dataTable.id,
					name: dataTable.name,
					file: options.preferLocalVersion ? localFile : remoteItem.filename,
					status: 'modified',
					location: options.preferLocalVersion ? 'local' : 'remote',
					conflict: options.direction === 'pull',
					updatedAt: dataTable.updatedAt?.toISOString(),
					owner,
				}),
			);
		}

		return files;
	}

	private dataTablesDiffer(local: DataTable, remote: ExportableDataTable): boolean {
		if (local.name !== remote.name) return true;
		const normalize = (columns: Array<{ name: string; type: string; index: number }>) =>
			[...columns]
				.sort((a, b) => a.index - b.index)
				.map((column) => `${column.index}:${column.name}:${column.type}`)
				.join(',');
		return normalize(local.columns ?? []) !== normalize(remote.columns ?? []);
	}

	private async getLocalDataTables(context: SourceControlContext): Promise<DataTable[]> {
		const projectIds = context.getAuthorizedProjectIds();
		if (projectIds === null) return await this.dataTableRepository.getMany({});
		if (projectIds.length === 0) return [];
		return await this.dataTableRepository.getMany({ filter: { projectId: projectIds } });
	}

	private async readRemoteDataTables(): Promise<
		Array<{ filename: string; parsed: ExportableDataTable }>
	> {
		const dataTableFiles = await glob('*.json', {
			cwd: path.join(this.gitFolder, SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER),
			absolute: true,
		});

		const result: Array<{ filename: string; parsed: ExportableDataTable }> = [];
		for (const file of dataTableFiles) {
			const parsed = await this.readJsonFile<ExportableDataTable>(file);
			if (!parsed?.id) continue;
			result.push({ filename: file, parsed });
		}
		return result;
	}

	private async findExistingDataTableIds(
		context: SourceControlContext,
		dataTableIds: string[],
	): Promise<Set<string>> {
		if (context.hasAccessToAllProjects() || dataTableIds.length === 0) return new Set();
		const existing = await this.dataTableRepository.getMany({ filter: { id: dataTableIds } });
		return new Set(existing.map((dataTable) => dataTable.id));
	}

	// ----------------------------------
	//              tags
	// ----------------------------------

	private async getTagsStatus(
		context: SourceControlContext,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[]> {
		const tagsFilePath = path.join(this.gitFolder, SOURCE_CONTROL_TAGS_EXPORT_FILE);
		const remote = await this.importService.getRemoteTagsAndMappingsFromFile(context);
		const local = await this.importService.getLocalTagsAndMappingsFromDb(context);

		if (this.tagsFilesEqual(local, remote)) return [];

		const remoteFileExists =
			(
				await glob(SOURCE_CONTROL_TAGS_EXPORT_FILE, {
					cwd: this.gitFolder,
					absolute: true,
				})
			).length > 0;

		return [
			this.toStatusFile({
				type: 'tags',
				id: 'tags',
				name: 'tags',
				file: tagsFilePath,
				status: remoteFileExists ? 'modified' : 'created',
				location: 'local',
				conflict: false,
			}),
		];
	}

	private tagsFilesEqual(a: TagsExportFile, b: TagsExportFile): boolean {
		const tagKey = (tag: { id: string; name: string }) => `${tag.id}:${tag.name}`;
		const mappingKey = (mapping: { tagId: string; workflowId: string }) =>
			`${mapping.tagId}:${mapping.workflowId}`;
		const sortedTags = (file: TagsExportFile) => file.tags.map(tagKey).sort().join(',');
		const sortedMappings = (file: TagsExportFile) => file.mappings.map(mappingKey).sort().join(',');
		return sortedTags(a) === sortedTags(b) && sortedMappings(a) === sortedMappings(b);
	}

	// ----------------------------------
	//             projects
	// ----------------------------------

	/**
	 * One `project` entry per team project owning a changed resource, so a push
	 * can serialize the owning projects alongside the resources themselves.
	 */
	private getProjectStatus(
		files: SourceControlledFile[],
		_options: SourceControlGetStatusOptions,
	): SourceControlledFile[] {
		const teamProjects = new Map<string, string>();
		for (const file of files) {
			if (file.status === 'deleted') continue;
			if (
				file.type !== 'workflow' &&
				file.type !== 'credential' &&
				file.type !== 'datatable' &&
				file.type !== 'folders'
			) {
				continue;
			}
			if (file.owner?.type !== 'team') continue;
			if (!teamProjects.has(file.owner.projectId)) {
				teamProjects.set(file.owner.projectId, file.owner.projectName);
			}
		}

		return [...teamProjects.entries()].map(([projectId, projectName]) =>
			this.toStatusFile({
				type: 'project',
				id: projectId,
				name: projectName,
				file: this.getProjectPath(projectId),
				status: 'created',
				location: 'local',
				owner: { type: 'team', projectId, projectName },
			}),
		);
	}

	// ----------------------------------
	//             helpers
	// ----------------------------------

	private toStatusFile(fields: {
		type: SourceControlledFile['type'];
		id: string;
		name: string;
		file: string;
		status: SourceControlledFile['status'];
		location: SourceControlledFile['location'];
		conflict?: boolean;
		updatedAt?: string;
		owner?: StatusOwner;
	}): SourceControlledFile {
		return {
			file: fields.file,
			id: fields.id,
			name: fields.name,
			type: fields.type,
			status: fields.status,
			location: fields.location,
			conflict: fields.conflict ?? false,
			updatedAt: fields.updatedAt ?? new Date().toISOString(),
			...(fields.owner ? { owner: fields.owner } : {}),
		};
	}

	private projectToStatusOwner(project: Project): StatusOwner {
		return {
			type: project.type === 'team' ? 'team' : 'personal',
			projectId: project.id,
			projectName: project.name,
		};
	}

	/**
	 * Map a serialized remote owner to the status-entry owner shape. Legacy bare
	 * emails and personal owners without a project id carry too little
	 * information and yield no owner.
	 */
	private remoteOwnerToStatusOwner(
		owner: RemoteResourceOwner | null | undefined,
	): StatusOwner | undefined {
		if (!owner || typeof owner === 'string') return undefined;
		if (owner.type === 'team') {
			return { type: 'team', projectId: owner.teamId, projectName: owner.teamName };
		}
		if (!owner.projectId) return undefined;
		return {
			type: 'personal',
			projectId: owner.projectId,
			projectName: owner.projectName ?? '',
		};
	}

	private isRemoteOwnerInScope(
		context: SourceControlContext,
		owner: RemoteResourceOwner | null | undefined,
	): boolean {
		if (context.hasAccessToAllProjects()) return true;
		if (!owner || typeof owner === 'string' || owner.type !== 'team') return false;
		return context.hasAccessToProject(owner.teamId);
	}

	private async readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
			const content = (await readFile(filePath, { encoding: 'utf8' })).toString();
			return jsonParse<T | null>(content, { fallbackValue: null });
		} catch (error) {
			this.logger.warn(`Failed to read source-control file ${filePath}`, { error });
			return null;
		}
	}
}
