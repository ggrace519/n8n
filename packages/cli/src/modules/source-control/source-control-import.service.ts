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
import { jsonParse, UnexpectedError } from 'n8n-workflow';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import type { SourceControlContext } from './source-control-context.factory';
import { SourceControlContextFactory } from './source-control-context.factory';
import type { TagsExportFile } from './source-control-export.service';
import { SourceControlScopedService } from './source-control-scoped.service';
import type { ExportableCredential } from './types/exportable-credential';
import type { ExportableFolder } from './types/exportable-folders';
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
			const credential = jsonParse<ExportableCredential>(
				(await readFile(candidate.file, { encoding: 'utf8' })).toString(),
			);

			const ownerProject = await this.findOrCreateOwnerProject(credential.ownedBy, importingUserId);
			const encryptedData = await cipher.encryptV2(credential.data ?? {});

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

			const clearActiveState = !existing || existing.isArchived;
			await this.workflowRepository.save({
				id: workflow.id,
				name: workflow.name,
				nodes: workflow.nodes,
				connections: workflow.connections,
				settings: workflow.settings ?? {},
				versionId,
				isArchived: workflow.isArchived ?? existing?.isArchived ?? false,
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
			if (existing) return existing;
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

	private async readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
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
