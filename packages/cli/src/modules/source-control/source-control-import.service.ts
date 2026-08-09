import type { SourceControlledFile } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { Project, User, WorkflowEntity } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	TagRepository,
	UserRepository,
	VariablesRepository,
	WorkflowRepository,
	WorkflowTagMappingRepository,
} from '@n8n/db';
import { Container, Service } from '@n8n/di';
import glob from 'fast-glob';
import isEqual from 'lodash/isEqual';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { Cipher, ErrorReporter, InstanceSettings } from 'n8n-core';
import { jsonParse, PROJECT_ROOT, UnexpectedError } from 'n8n-workflow';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER,
	SOURCE_CONTROL_FOLDERS_EXPORT_FILE,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import type { SourceControlContext } from './source-control-context.factory';
import { SourceControlContextFactory } from './source-control-context.factory';
import type { TagsExportFile } from './source-control-export.service';
import {
	assertNotSymlink,
	assertParentWithinFolder,
	mergeCredentialData,
} from './source-control-helper';
import { SourceControlScopedService } from './source-control-scoped.service';
import type { ExportableCredential } from './types/exportable-credential';
import type { ExportableDataTable } from './types/exportable-data-table';
import type { ExportableFolder, FolderExportFile } from './types/exportable-folders';
import type { RemoteResourceOwner } from './types/resource-owner';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { CredentialsService } from '@/credentials/credentials.service';
import { EventService } from '@/events/event.service';
import { ExecutionPersistence } from '@/executions/execution-persistence';
import type { IWorkflowToImport } from '@/interfaces';
import { DataTableSizeValidator } from '@/modules/data-table/data-table-size-validator.service';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { RedactionEnforcementService } from '@/modules/redaction/redaction-enforcement.service';
import { FolderService } from '@/services/folder.service';
import { ProjectService } from '@/services/project.service';
import { TagService } from '@/services/tag.service';
import { VariablesService } from '@/variables/variables.service';
import { WorkflowHistoryService } from '@/workflows/workflow-history/workflow-history.service';
import { WorkflowMutationHooksProxy } from '@/workflows/workflow-mutation-hooks-proxy.service';
import { WorkflowPublishGuardProxy } from '@/workflows/workflow-publish-guard-proxy.service';
import { WorkflowService } from '@/workflows/workflow.service';

/** A workflow's identity in the work folder or the local database. */
export interface SourceControlWorkflowVersionId {
	id: string;
	versionId: string;
	filename: string;
	name?: string;
	parentFolderId: string | null;
	updatedAt?: string;
	owner?: RemoteResourceOwner;
}

/** A credential stub as parsed from `credential_stubs/<id>.json`. */
export type RemoteCredentialFile = Partial<ExportableCredential> &
	Pick<ExportableCredential, 'id'> & { filename: string };

/** A credential as listed from the local database for status comparison. */
export interface SourceControlCredentialListItem {
	id: string;
	name: string;
	type: string;
	data: string;
	filename: string;
	ownedBy: RemoteResourceOwner | null;
	isGlobal: boolean;
	isResolvable: boolean;
	resolvableAllowFallback: boolean;
}

type RemoteWorkflowFile = Partial<IWorkflowToImport> & { updatedAt?: string };

const DATA_TABLE_COLUMN_TYPES = ['string', 'number', 'boolean', 'date'] as const;
type DataTableColumnType = (typeof DATA_TABLE_COLUMN_TYPES)[number];

function isDataTableColumnType(value: unknown): value is DataTableColumnType {
	return (
		typeof value === 'string' && (DATA_TABLE_COLUMN_TYPES as readonly string[]).includes(value)
	);
}

/** Narrow an already-validated column type for DTO construction. */
function asDataTableColumnType(value: string): DataTableColumnType {
	if (!isDataTableColumnType(value)) {
		throw new UnexpectedError(`Invalid data table column type: ${value}`);
	}
	return value;
}

/**
 * Applies the source-control work folder to the local instance: discovery of
 * remote (file) and local (database) resources filtered by the caller's
 * source-control scope, and the import of workflows, credentials, and tags.
 *
 * Scope rules: an instance-wide context (global owner/admin) sees everything;
 * a project-scoped admin sees only resources serialized/owned by their
 * administered team projects (a serialized personal owner never matches, even
 * when it is their own email); everyone else sees nothing. Tag definitions
 * are global, tag mappings are workflow-scoped.
 */
@Service()
export class SourceControlImportService {
	private readonly gitFolder: string;

	constructor(
		private readonly logger: Logger,
		private readonly errorReporter: ErrorReporter,
		private readonly eventService: EventService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly variablesRepository: VariablesRepository,
		private readonly tagRepository: TagRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly userRepository: UserRepository,
		private readonly variablesService: VariablesService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowTagMappingRepository: WorkflowTagMappingRepository,
		private readonly dataTableService: DataTableService,
		private readonly folderService: FolderService,
		private readonly tagService: TagService,
		private readonly folderRepository: FolderRepository,
		instanceSettings: InstanceSettings,
		private readonly sourceControlContextFactory: SourceControlContextFactory,
		private readonly sourceControlScopedService: SourceControlScopedService,
		private readonly workflowHistoryService: WorkflowHistoryService,
		private readonly workflowService: WorkflowService,
		private readonly projectService: ProjectService,
		private readonly credentialsService: CredentialsService,
		private readonly redactionEnforcementService: RedactionEnforcementService,
		private readonly dataTableSizeValidator: DataTableSizeValidator,
		private readonly activeWorkflowManager: ActiveWorkflowManager,
		private readonly executionPersistence: ExecutionPersistence,
		private readonly workflowPublishGuard: WorkflowPublishGuardProxy,
		private readonly workflowMutationHooks: WorkflowMutationHooksProxy,
	) {
		this.gitFolder = path.join(instanceSettings.n8nFolder, SOURCE_CONTROL_GIT_FOLDER);
	}

	// ----------------------------------
	//       remote/local discovery
	// ----------------------------------

	async getRemoteVersionIdsFromFiles(
		context: SourceControlContext,
	): Promise<SourceControlWorkflowVersionId[]> {
		if (!context.hasAnyAccess()) return [];

		const workflowFiles = await glob('*.json', {
			cwd: path.join(this.gitFolder, SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER),
			absolute: true,
		});

		const remote: SourceControlWorkflowVersionId[] = [];
		for (const file of workflowFiles) {
			const parsed = await this.readJsonFile<RemoteWorkflowFile>(file);
			if (!parsed?.id || !parsed.versionId) continue;
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

	async getLocalVersionIdsFromDb(
		context: SourceControlContext,
	): Promise<SourceControlWorkflowVersionId[]> {
		const workflows = await this.getLocalWorkflowEntities(context);
		return workflows.map((workflow) => ({
			id: workflow.id,
			versionId: workflow.versionId,
			filename: this.getWorkflowPath(workflow.id),
			name: workflow.name,
			parentFolderId: workflow.parentFolder?.id ?? null,
			updatedAt: workflow.updatedAt?.toISOString(),
		}));
	}

	async getRemoteCredentialsFromFiles(
		context: SourceControlContext,
	): Promise<RemoteCredentialFile[]> {
		if (!context.hasAnyAccess()) return [];

		const credentialFiles = await glob('*.json', {
			cwd: path.join(this.gitFolder, SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER),
			absolute: true,
		});

		const remote: RemoteCredentialFile[] = [];
		for (const file of credentialFiles) {
			const parsed = await this.readJsonFile<Partial<ExportableCredential>>(file);
			if (!parsed?.id) continue;
			if (!this.isRemoteOwnerInScope(context, parsed.ownedBy)) continue;
			remote.push({ ...parsed, id: parsed.id, filename: file });
		}
		return remote;
	}

	async getLocalCredentialsFromDb(
		context: SourceControlContext,
	): Promise<SourceControlCredentialListItem[]> {
		const projectIds = context.getAuthorizedProjectIds();
		const ownerSharings =
			projectIds === null
				? await this.sharedCredentialsRepository.findOwnedCredentialsInProjects()
				: await this.sharedCredentialsRepository.findOwnedCredentialsInProjects(projectIds);

		const items: SourceControlCredentialListItem[] = [];
		for (const sharing of ownerSharings) {
			const credential = sharing.credentials;
			if (!credential) continue;
			items.push({
				id: credential.id,
				name: credential.name,
				type: credential.type,
				data: credential.data,
				filename: this.getCredentialsPath(credential.id),
				ownedBy: sharing.project ? this.toLocalResourceOwner(sharing.project) : null,
				isGlobal: credential.isGlobal ?? false,
				isResolvable: credential.isResolvable ?? false,
				resolvableAllowFallback: credential.resolvableAllowFallback ?? false,
			});
		}
		return items;
	}

	async getLocalFoldersAndMappingsFromDb(
		context: SourceControlContext,
	): Promise<{ folders: ExportableFolder[] }> {
		const projectIds = context.getAuthorizedProjectIds();
		const folders =
			projectIds === null
				? await this.folderRepository.findManyWithHomeProject()
				: await this.folderRepository.findManyWithHomeProject(projectIds);

		return {
			folders: folders.map((folder) => ({
				id: folder.id,
				name: folder.name,
				homeProjectId: folder.homeProject.id,
				parentFolderId: folder.parentFolderId ?? null,
				createdAt: folder.createdAt.toISOString(),
				updatedAt: folder.updatedAt.toISOString(),
			})),
		};
	}

	async getRemoteTagsAndMappingsFromFile(context: SourceControlContext): Promise<TagsExportFile> {
		const tagsFiles = await glob(SOURCE_CONTROL_TAGS_EXPORT_FILE, {
			cwd: this.gitFolder,
			absolute: true,
		});
		if (tagsFiles.length === 0) return { tags: [], mappings: [] };

		const parsed = (await this.readJsonFile<TagsExportFile>(tagsFiles[0])) ?? {
			tags: [],
			mappings: [],
		};
		return {
			tags: parsed.tags ?? [],
			mappings: await this.filterMappingsToScope(context, parsed.mappings ?? []),
		};
	}

	async getLocalTagsAndMappingsFromDb(context: SourceControlContext): Promise<TagsExportFile> {
		const tags = (await this.tagRepository.findAllTags()).map(({ id, name }) => ({ id, name }));

		const projectIds = context.getAuthorizedProjectIds();
		let mappings: Array<{ tagId: string; workflowId: string }>;
		if (projectIds === null) {
			mappings = await this.workflowTagMappingRepository.findAllMappings();
		} else if (projectIds.length === 0) {
			mappings = [];
		} else {
			const workflowIds =
				await this.sharedWorkflowRepository.findWorkflowIdsOwnedByProjects(projectIds);
			mappings = await this.workflowTagMappingRepository.findMappingsForWorkflows(workflowIds);
		}

		return {
			tags,
			mappings: mappings.map(({ tagId, workflowId }) => ({ tagId, workflowId })),
		};
	}

	// ----------------------------------
	//              import
	// ----------------------------------

	/**
	 * Upserts the tag definitions from `tags.json` (tags are never deleted on
	 * import) and reconciles workflow/tag mappings: every workflow represented
	 * in the imported data has its local mappings replaced by the remote ones —
	 * a represented workflow with no remote mappings loses all its local tags.
	 * Workflows not represented in the import are left untouched. When the tag
	 * file has no mappings at all, the workflow files are scanned to determine
	 * which workflows are represented and thus eligible for mapping removal.
	 */
	async importTagsFromWorkFolder(candidate: SourceControlledFile, user: User): Promise<unknown> {
		const context = await this.sourceControlContextFactory.createContext(user);

		await assertNotSymlink(candidate.file);
		await assertParentWithinFolder(candidate.file, this.gitFolder);
		const tagsFile = jsonParse<TagsExportFile>(
			(await readFile(candidate.file, { encoding: 'utf8' })).toString(),
			{ fallbackValue: { tags: [], mappings: [] } },
		);
		const tags = tagsFile.tags ?? [];
		const mappings = tagsFile.mappings ?? [];

		for (const tag of tags) {
			if (!tag.id || !tag.name) continue;
			await this.tagRepository.upsert({ id: tag.id, name: tag.name }, ['id']);
		}

		const representedIds =
			mappings.length > 0
				? [...new Set(mappings.map((mapping) => mapping.workflowId))]
				: (await this.getRemoteVersionIdsFromFiles(context)).map((workflow) => workflow.id);
		if (representedIds.length === 0) return tagsFile;

		const reconcilableIds = await this.filterToLocalWorkflowsInScope(context, representedIds);
		if (reconcilableIds.length === 0) return tagsFile;

		// Mappings may reference tags unknown to this instance; skip those to
		// keep referential integrity instead of failing the whole import.
		const knownTagIds = new Set((await this.tagRepository.findAllTags()).map((tag) => tag.id));

		for (const workflowId of reconcilableIds) {
			const tagIds = [
				...new Set(
					mappings
						.filter((mapping) => mapping.workflowId === workflowId)
						.map((mapping) => mapping.tagId),
				),
			].filter((tagId) => knownTagIds.has(tagId));

			if (tagIds.length === 0) {
				await this.workflowTagMappingRepository.delete({ workflowId });
			} else {
				await this.workflowTagMappingRepository.overwriteTaggings(workflowId, tagIds);
			}
		}

		return tagsFile;
	}

	/**
	 * Imports credential stubs: the credential row is upserted with the data
	 * re-encrypted for this instance, and ownership is replaced so only the
	 * serialized owner remains. Owner resolution: a structured team owner finds
	 * the project by id or recreates it with the exact source id and name; a
	 * personal owner (structured or legacy bare email) resolves to that user's
	 * personal project, falling back to the importing user's personal project
	 * when the user is unknown or no owner is serialized.
	 */
	async importCredentialsFromWorkFolder(
		candidates: SourceControlledFile[],
		importingUserId: string,
	): Promise<unknown> {
		// Resolved from the container at use so the instance-wide Cipher (the one
		// swapped in by tests and shared with the credentials subsystem) is used.
		const cipher = Container.get(Cipher);

		const imported: Array<{ id: string; name: string; type: string }> = [];
		for (const candidate of candidates) {
			await assertNotSymlink(candidate.file);
			await assertParentWithinFolder(candidate.file, this.gitFolder);
			const credential = jsonParse<ExportableCredential>(
				(await readFile(candidate.file, { encoding: 'utf8' })).toString(),
			);

			const ownerProject = await this.findOrCreateOwnerProject(credential.ownedBy, importingUserId);

			// Git only holds sanitized stubs. For an existing credential the local
			// secrets are the source of truth: merge the stub over the decrypted
			// local data so blank placeholders (and never-exported fields like
			// `oauthTokenData`) keep their local values. Only a newly created
			// credential stores the stub as-is.
			const existing = await this.credentialsRepository.findOneBy({ id: credential.id });
			const incomingData = credential.data ?? {};
			const dataToStore = existing
				? mergeCredentialData(
						await this.decryptStoredCredentialData(cipher, existing.data),
						incomingData,
					)
				: incomingData;
			const encryptedData = await cipher.encryptV2(dataToStore);

			await this.credentialsRepository.upsert(
				{
					id: credential.id,
					name: credential.name,
					type: credential.type,
					data: encryptedData,
					isGlobal: credential.isGlobal ?? false,
					...(credential.isResolvable !== undefined
						? { isResolvable: credential.isResolvable }
						: {}),
					...(credential.resolvableAllowFallback !== undefined
						? { resolvableAllowFallback: credential.resolvableAllowFallback }
						: {}),
				},
				['id'],
			);

			// Ownership follows source control: any pre-existing sharing rows are
			// replaced so only the serialized owner remains.
			await this.sharedCredentialsRepository.transferOwnership(credential.id, ownerProject.id);

			imported.push({ id: credential.id, name: credential.name, type: credential.type });
		}
		return imported;
	}

	/**
	 * Imports workflow files. A file missing `versionId`, `nodes`, or
	 * `connections` is skipped without error and without creating a row. Each
	 * imported version is recorded in workflow history with the author
	 * `import by <firstName> <lastName>`; an existing `(workflowId, versionId)`
	 * history row is only rewritten when its content actually changed. The
	 * local active state is preserved for existing workflows — except archived
	 * ones, which must never stay active, so their `active`/`activeVersionId`
	 * are cleared even when the incoming file is unarchived.
	 */
	async importWorkflowFromWorkFolder(
		candidates: SourceControlledFile[],
		importingUserId: string,
	): Promise<unknown[]> {
		const importingUser = await this.userRepository.findOneBy({ id: importingUserId });
		if (!importingUser) {
			throw new UnexpectedError(`Importing user ${importingUserId} not found`);
		}
		const importAuthor = `import by ${importingUser.firstName} ${importingUser.lastName}`;

		const imported: Array<{ id: string; name: string }> = [];
		for (const candidate of candidates) {
			await assertNotSymlink(candidate.file);
			await assertParentWithinFolder(candidate.file, this.gitFolder);
			const workflow = jsonParse<IWorkflowToImport>(
				(await readFile(candidate.file, { encoding: 'utf8' })).toString(),
			);

			const { versionId } = workflow;
			if (!versionId || !workflow.nodes || !workflow.connections) {
				this.logger.warn(
					`Skipping workflow file ${candidate.file}: missing versionId, nodes, or connections`,
				);
				continue;
			}

			const existing = await this.workflowRepository.findOne({ where: { id: workflow.id } });

			// The parent folder may not exist yet on this instance (folders are a
			// separate import concern); never point at a missing folder.
			const parentFolder = workflow.parentFolderId
				? await this.folderRepository.findOneBy({ id: workflow.parentFolderId })
				: null;

			// A workflow must never persist as archived-but-active, so the decision
			// is based on the *resulting* archive state: clear when the incoming
			// file is archived, when the existing row is (even if the incoming file
			// un-archives it), or on creation.
			const isArchived = workflow.isArchived ?? existing?.isArchived ?? false;
			const clearActiveState = !existing || existing.isArchived || isArchived;
			if (clearActiveState && existing?.active) {
				// Keep runtime triggers/webhooks in sync with the persisted state.
				try {
					await this.activeWorkflowManager.remove(workflow.id);
				} catch (error) {
					this.logger.warn(`Failed to deactivate workflow ${workflow.id} during import`, {
						error: ensureError(error),
					});
				}
			}
			await this.workflowRepository.save({
				id: workflow.id,
				name: workflow.name,
				nodes: workflow.nodes,
				connections: workflow.connections,
				settings: workflow.settings ?? {},
				versionId,
				isArchived,
				nodeGroups: workflow.nodeGroups ?? existing?.nodeGroups ?? [],
				parentFolder,
				...(clearActiveState ? { active: false, activeVersionId: null } : {}),
			});

			if (!existing) {
				const ownerProject = await this.findOrCreateOwnerProject(workflow.owner, importingUserId);
				await this.sharedWorkflowRepository.makeOwner([workflow.id], ownerProject.id);
			}

			await this.upsertWorkflowHistory(workflow, versionId, importAuthor);

			imported.push({ id: workflow.id, name: workflow.name });
		}
		return imported;
	}

	/**
	 * Applies the remote `folders.json` to the local instance: creates missing
	 * in-scope folders (preserving their ids) and updates name/parent of
	 * existing ones. Folders are processed parents-first so a child can attach
	 * to its just-created parent; folders whose home project does not exist
	 * locally are skipped (project creation is a resource-import concern).
	 */
	async importFoldersFromWorkFolder(user: User): Promise<ExportableFolder[]> {
		const context = await this.sourceControlContextFactory.createContext(user);

		const matches = await glob(SOURCE_CONTROL_FOLDERS_EXPORT_FILE, {
			cwd: this.gitFolder,
			absolute: true,
		});
		if (matches.length === 0) return [];
		const parsed = await this.readJsonFile<FolderExportFile>(matches[0]);
		const remoteFolders = (parsed?.folders ?? []).filter(
			(folder) =>
				Boolean(folder?.id) &&
				Boolean(folder.homeProjectId) &&
				context.hasAccessToProject(folder.homeProjectId),
		);

		const imported: ExportableFolder[] = [];
		for (const folder of this.sortFoldersParentsFirst(remoteFolders)) {
			try {
				const project = await this.projectRepository.findById(folder.homeProjectId);
				if (!project) {
					this.logger.warn(
						`Skipping folder ${folder.id}: home project ${folder.homeProjectId} does not exist locally`,
					);
					continue;
				}

				const [existingLocal] = await this.folderService.getFoldersByIds([folder.id]);
				const parentExistsLocally = folder.parentFolderId
					? (await this.folderService.getFoldersByIds([folder.parentFolderId])).length > 0
					: false;

				if (!existingLocal) {
					await this.folderService.createFolder(
						{
							name: folder.name,
							...(parentExistsLocally && folder.parentFolderId
								? { parentFolderId: folder.parentFolderId }
								: {}),
						},
						folder.homeProjectId,
						folder.id,
					);
				} else {
					await this.folderService.updateFolder(folder.id, existingLocal.homeProject.id, {
						name: folder.name,
						parentFolderId:
							parentExistsLocally && folder.parentFolderId ? folder.parentFolderId : PROJECT_ROOT,
					});
				}
				imported.push(folder);
			} catch (error) {
				this.logger.warn(`Failed to import folder ${folder.id}`, { error: ensureError(error) });
			}
		}
		return imported;
	}

	/**
	 * Applies remote data-table files: creates missing tables (preserving their
	 * ids) and reconciles name and columns of existing ones. Columns are
	 * matched by name; a type change is applied as remove-and-recreate. Import
	 * is best-effort per table — one broken file must not abort the pull.
	 */
	async importDataTablesFromWorkFolder(
		candidates: SourceControlledFile[],
		importingUserId: string,
	): Promise<Array<{ id: string; name: string }>> {
		const imported: Array<{ id: string; name: string }> = [];
		for (const candidate of candidates) {
			try {
				const parsed = await this.readJsonFile<ExportableDataTable>(candidate.file);
				if (!parsed?.id || !parsed.name) continue;

				const remoteColumns = (parsed.columns ?? []).filter(
					(column) => Boolean(column?.name) && isDataTableColumnType(column.type),
				);

				const [existing] = await this.dataTableService.findDataTablesByIds([parsed.id]);
				if (!existing) {
					const ownerProject = await this.findOrCreateOwnerProject(
						parsed.ownedBy ?? null,
						importingUserId,
					);
					await this.dataTableService.createDataTable(
						ownerProject.id,
						{
							name: parsed.name,
							columns: [...remoteColumns]
								.sort((a, b) => a.index - b.index)
								.map(({ name, type, index }) => ({
									name,
									type: asDataTableColumnType(type),
									index,
								})),
						},
						parsed.id,
					);
				} else {
					const projectId = existing.projectId;
					if (existing.name !== parsed.name) {
						await this.dataTableService.updateDataTable(parsed.id, projectId, {
							name: parsed.name,
						});
					}
					const localColumns = existing.columns ?? [];
					const remoteByName = new Map(remoteColumns.map((column) => [column.name, column]));
					for (const localColumn of localColumns) {
						const remoteColumn = remoteByName.get(localColumn.name);
						if (!remoteColumn) {
							await this.dataTableService.deleteColumn(parsed.id, projectId, localColumn.id);
						} else if (remoteColumn.type !== localColumn.type) {
							await this.dataTableService.deleteColumn(parsed.id, projectId, localColumn.id);
							await this.dataTableService.addColumn(parsed.id, projectId, {
								name: remoteColumn.name,
								type: asDataTableColumnType(remoteColumn.type),
								index: remoteColumn.index,
							});
						}
					}
					for (const remoteColumn of remoteColumns) {
						if (!localColumns.some((localColumn) => localColumn.name === remoteColumn.name)) {
							await this.dataTableService.addColumn(parsed.id, projectId, {
								name: remoteColumn.name,
								type: asDataTableColumnType(remoteColumn.type),
								index: remoteColumn.index,
							});
						}
					}
				}
				imported.push({ id: parsed.id, name: parsed.name });
			} catch (error) {
				this.logger.warn(`Failed to import data table ${candidate.id}`, {
					error: ensureError(error),
				});
			}
		}
		return imported;
	}

	/**
	 * Deletes local workflows that a pull reported as removed from the remote.
	 * Deletion runs through the workflow service so triggers are torn down and
	 * lifecycle hooks fire; a failure (e.g. a still-published workflow) skips
	 * that workflow instead of aborting the pull.
	 */
	async deleteWorkflowsRemovedFromRemote(
		user: User,
		candidates: SourceControlledFile[],
	): Promise<void> {
		for (const candidate of candidates) {
			try {
				await this.workflowService.delete(user, candidate.id, true);
			} catch (error) {
				this.logger.warn(`Failed to delete workflow ${candidate.id} during pull`, {
					error: ensureError(error),
				});
			}
		}
	}

	/** Deletes local credentials that a pull reported as removed from the remote. */
	async deleteCredentialsRemovedFromRemote(
		user: User,
		candidates: SourceControlledFile[],
	): Promise<void> {
		for (const candidate of candidates) {
			try {
				await this.credentialsService.delete(user, candidate.id);
			} catch (error) {
				this.logger.warn(`Failed to delete credential ${candidate.id} during pull`, {
					error: ensureError(error),
				});
			}
		}
	}

	/** Deletes local folders that a pull reported as removed from the remote. */
	async deleteFoldersRemovedFromRemote(
		user: User,
		candidates: SourceControlledFile[],
	): Promise<void> {
		for (const candidate of candidates) {
			try {
				const [folder] = await this.folderService.getFoldersByIds([candidate.id]);
				if (!folder) continue;
				await this.folderService.deleteFolder(user, folder.id, folder.homeProject.id, {});
			} catch (error) {
				this.logger.warn(`Failed to delete folder ${candidate.id} during pull`, {
					error: ensureError(error),
				});
			}
		}
	}

	/** Deletes local data tables that a pull reported as removed from the remote. */
	async deleteDataTablesRemovedFromRemote(candidates: SourceControlledFile[]): Promise<void> {
		for (const candidate of candidates) {
			try {
				const [existing] = await this.dataTableService.findDataTablesByIds([candidate.id]);
				if (!existing) continue;
				await this.dataTableService.deleteDataTable(existing.id, existing.projectId);
			} catch (error) {
				this.logger.warn(`Failed to delete data table ${candidate.id} during pull`, {
					error: ensureError(error),
				});
			}
		}
	}

	/** Orders folders so every parent precedes its children; cycles and unknown parents break to root level. */
	private sortFoldersParentsFirst(folders: ExportableFolder[]): ExportableFolder[] {
		const remaining = new Map(folders.map((folder) => [folder.id, folder]));
		const sorted: ExportableFolder[] = [];
		let progressed = true;
		while (remaining.size > 0 && progressed) {
			progressed = false;
			for (const [id, folder] of remaining) {
				const parentPending = folder.parentFolderId && remaining.has(folder.parentFolderId);
				if (!parentPending) {
					sorted.push(folder);
					remaining.delete(id);
					progressed = true;
				}
			}
		}
		// Any leftovers form a parent cycle; import them anyway (parent linking
		// falls back to root when the parent is missing locally).
		sorted.push(...remaining.values());
		return sorted;
	}

	// ----------------------------------
	//             helpers
	// ----------------------------------

	getWorkflowPath(workflowId: string): string {
		return path.join(this.gitFolder, SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER, `${workflowId}.json`);
	}

	getCredentialsPath(credentialId: string): string {
		return path.join(
			this.gitFolder,
			SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER,
			`${credentialId}.json`,
		);
	}

	private async upsertWorkflowHistory(
		workflow: IWorkflowToImport,
		versionId: string,
		importAuthor: string,
	): Promise<void> {
		const existingVersion = await this.workflowHistoryService.findVersion(workflow.id, versionId);

		if (!existingVersion) {
			const versionMetadata = workflow.versionMetadata
				? {
						name: workflow.versionMetadata.name ?? undefined,
						description: workflow.versionMetadata.description ?? undefined,
					}
				: undefined;
			await this.workflowHistoryService.saveVersion(
				importAuthor,
				{
					versionId,
					nodes: workflow.nodes,
					connections: workflow.connections,
					nodeGroups: workflow.nodeGroups,
				},
				workflow.id,
				false,
				undefined,
				undefined,
				versionMetadata,
			);
			return;
		}

		const contentChanged =
			!isEqual(existingVersion.nodes, workflow.nodes) ||
			!isEqual(existingVersion.connections, workflow.connections);
		// An unchanged version must stay byte-for-byte untouched (author and
		// updatedAt included), so a repeated pull is a no-op.
		if (!contentChanged) return;

		await this.workflowHistoryService.updateVersion(workflow.id, versionId, {
			nodes: workflow.nodes,
			connections: workflow.connections,
			authors: importAuthor,
		});
	}

	/**
	 * Whether a serialized remote owner is visible to the caller. Instance-wide
	 * contexts see everything; scoped contexts only see resources serialized as
	 * owned by one of their administered team projects — personal owners never
	 * match a scoped context, even when the email is the caller's own.
	 */
	private isRemoteOwnerInScope(
		context: SourceControlContext,
		owner: RemoteResourceOwner | null | undefined,
	): boolean {
		if (context.hasAccessToAllProjects()) return true;
		if (!owner || typeof owner === 'string' || owner.type !== 'team') return false;
		return context.hasAccessToProject(owner.teamId);
	}

	private async getLocalWorkflowEntities(context: SourceControlContext): Promise<WorkflowEntity[]> {
		const projectIds = context.getAuthorizedProjectIds();
		if (projectIds === null) {
			return await this.workflowRepository.find({ relations: { parentFolder: true } });
		}
		if (projectIds.length === 0) return [];
		const workflowIds =
			await this.sharedWorkflowRepository.findWorkflowIdsOwnedByProjects(projectIds);
		return await this.workflowRepository.findByIdsWithParentFolder(workflowIds);
	}

	/**
	 * Remote mapping visibility is decided by the *locally known* ownership of
	 * the mapped workflow, since the mapping itself carries no owner.
	 */
	private async filterMappingsToScope(
		context: SourceControlContext,
		mappings: TagsExportFile['mappings'],
	): Promise<TagsExportFile['mappings']> {
		if (context.hasAccessToAllProjects()) return mappings;
		const projectIds = context.getAuthorizedProjectIds() ?? [];
		if (projectIds.length === 0) return [];
		const inScope = new Set(
			await this.sharedWorkflowRepository.findWorkflowIdsOwnedByProjects(projectIds),
		);
		return mappings.filter((mapping) => inScope.has(mapping.workflowId));
	}

	/** Restrict remote workflow ids to workflows that exist locally and are in the caller's scope. */
	private async filterToLocalWorkflowsInScope(
		context: SourceControlContext,
		workflowIds: string[],
	): Promise<string[]> {
		const projectIds = context.getAuthorizedProjectIds();
		if (projectIds === null) {
			const localWorkflows = await this.workflowRepository.findByIds(workflowIds);
			return localWorkflows.map((workflow) => workflow.id);
		}
		if (projectIds.length === 0) return [];
		const inScope = new Set(
			await this.sharedWorkflowRepository.findWorkflowIdsOwnedByProjects(projectIds),
		);
		return workflowIds.filter((workflowId) => inScope.has(workflowId));
	}

	/**
	 * Resolves the serialized owner to a local project, creating a team project
	 * with the exact source id and name when it does not exist here.
	 */
	private async findOrCreateOwnerProject(
		owner: RemoteResourceOwner | null | undefined,
		importingUserId: string,
	): Promise<Project> {
		if (owner && typeof owner === 'object' && owner.type === 'team') {
			const existing = await this.projectRepository.findById(owner.teamId);
			if (existing) {
				// A serialized team id must only ever resolve to a team project. On
				// an id collision with e.g. a personal project, fall back to the
				// importing user instead of exposing the resource to that project.
				if (existing.type === 'team') return existing;
				this.logger.warn(
					`Serialized team owner ${owner.teamId} collides with a local non-team project; falling back to the importing user`,
				);
				return await this.projectRepository.getPersonalProjectForUserOrFail(importingUserId);
			}
			return await this.projectRepository.save(
				this.projectRepository.create({
					id: owner.teamId,
					name: owner.teamName,
					type: 'team',
				}),
			);
		}

		const personalEmail =
			typeof owner === 'string' ? owner : owner?.type === 'personal' ? owner.personalEmail : null;
		if (personalEmail) {
			const ownerUser = await this.userRepository.findOneBy({ email: personalEmail });
			if (ownerUser) {
				const personalProject = await this.projectRepository.getPersonalProjectForUser(
					ownerUser.id,
				);
				if (personalProject) return personalProject;
			}
		}

		return await this.projectRepository.getPersonalProjectForUserOrFail(importingUserId);
	}

	private toLocalResourceOwner(project: Project): RemoteResourceOwner {
		if (project.type === 'team') {
			return { type: 'team', teamId: project.id, teamName: project.name };
		}
		return {
			type: 'personal',
			projectId: project.id,
			projectName: project.name,
			personalEmail: project.projectRelations?.[0]?.user?.email ?? '',
		};
	}

	/**
	 * Decrypt a locally stored credential payload for merging. Any failure
	 * (foreign encryption key, corrupted row) yields `{}` so the import falls
	 * back to storing the incoming stub as-is.
	 */
	private async decryptStoredCredentialData(
		cipher: Cipher,
		encryptedData: string,
	): Promise<Record<string, unknown>> {
		try {
			const decrypted = await cipher.decryptV2(encryptedData);
			const parsed = jsonParse<Record<string, unknown> | null>(decrypted, { fallbackValue: null });
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private async readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
			await assertNotSymlink(filePath);
			await assertParentWithinFolder(filePath, this.gitFolder);
			const content = (await readFile(filePath, { encoding: 'utf8' })).toString();
			return jsonParse<T | null>(content, { fallbackValue: null });
		} catch (e) {
			this.logger.warn(`Failed to read source-control file ${filePath}`, {
				error: ensureError(e),
			});
			return null;
		}
	}
}
