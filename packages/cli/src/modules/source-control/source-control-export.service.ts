import type { SourceControlledFile } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { CredentialsEntity, Folder, Project, WorkflowEntity } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	ProjectRelationRepository,
	SharedWorkflowRepository,
	TagRepository,
	WorkflowRepository,
	WorkflowTagMappingRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { PROJECT_OWNER_ROLE_SLUG } from '@n8n/permissions';
import { Cipher, InstanceSettings } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER,
	SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER,
	SOURCE_CONTROL_FOLDERS_EXPORT_FILE,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import type { SourceControlContext } from './source-control-context.factory';
import { assertNotSymlink } from './source-control-helper';
import type { ExportableCredential } from './types/exportable-credential';
import type { ExportableDataTable } from './types/exportable-data-table';
import type { ExportableFolder, FolderExportFile } from './types/exportable-folders';
import type { ExportableWorkflow } from './types/exportable-workflow';
import type { StructuredResourceOwner } from './types/resource-owner';

import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import type { DataTable } from '@/modules/data-table/data-table.entity';

export interface SourceControlExportResult {
	count: number;
	files: string[];
	missingIds: string[];
}

/** Shape of the aggregate `tags.json` in the work folder. */
export interface TagsExportFile {
	tags: Array<{ id: string; name: string }>;
	mappings: Array<{ tagId: string; workflowId: string }>;
}

/**
 * Serializes local resources into the source-control work folder
 * (`${n8nFolder}/git/`). Per-resource files (workflows, credential stubs,
 * data tables) are written one JSON file per resource; folders and tags are
 * aggregate files that scoped exports merge rather than overwrite, so a
 * project-scoped push never erases entries owned by out-of-scope projects.
 */
@Service()
export class SourceControlExportService {
	private readonly gitFolder: string;

	constructor(
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly tagRepository: TagRepository,
		private readonly workflowTagMappingRepository: WorkflowTagMappingRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly folderRepository: FolderRepository,
		private readonly dataTableRepository: DataTableRepository,
		instanceSettings: InstanceSettings,
	) {
		this.gitFolder = path.join(instanceSettings.n8nFolder, SOURCE_CONTROL_GIT_FOLDER);
		this.logger = this.logger.scoped('source-control');
	}

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

	getDataTablePath(dataTableId: string): string {
		return path.join(
			this.gitFolder,
			SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER,
			`${dataTableId}.json`,
		);
	}

	getTagsPath(): string {
		return path.join(this.gitFolder, SOURCE_CONTROL_TAGS_EXPORT_FILE);
	}

	getFoldersPath(): string {
		return path.join(this.gitFolder, SOURCE_CONTROL_FOLDERS_EXPORT_FILE);
	}

	async exportCredentialsToWorkFolder(
		candidates: SourceControlledFile[],
	): Promise<SourceControlExportResult> {
		const candidateIds = candidates.map((candidate) => candidate.id);
		const credentials =
			candidateIds.length > 0
				? await this.credentialsRepository.getManyByIds(candidateIds, { withSharings: true })
				: [];
		const credentialsById = new Map(credentials.map((credential) => [credential.id, credential]));
		const ownersById = await this.resolveCredentialOwners(credentials);

		await mkdir(path.join(this.gitFolder, SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER), {
			recursive: true,
		});

		const files: string[] = [];
		const missingIds: string[] = [];
		for (const candidateId of candidateIds) {
			const credential = credentialsById.get(candidateId);
			if (!credential) {
				missingIds.push(candidateId);
				continue;
			}
			const stub = await this.toExportableCredential(
				credential,
				ownersById.get(credential.id) ?? null,
			);
			const filePath = this.getCredentialsPath(credential.id);
			// A repository-provided symlink at a managed path must never redirect
			// the write outside the work folder.
			await assertNotSymlink(filePath);
			await writeFile(filePath, JSON.stringify(stub, null, 2));
			files.push(filePath);
		}

		if (missingIds.length > 0) {
			this.logger.debug('Skipped exporting missing credentials', { missingIds });
		}

		return { count: files.length, files, missingIds };
	}

	async exportTagsToWorkFolder(context: SourceControlContext): Promise<SourceControlExportResult> {
		await mkdir(this.gitFolder, { recursive: true });

		const tags = (await this.tagRepository.findAllTags()).map(({ id, name }) => ({ id, name }));
		const mappings = await this.getExportableTagMappings(context);

		const filePath = this.getTagsPath();
		const fileContent: TagsExportFile = { tags, mappings };
		await assertNotSymlink(filePath);
		await writeFile(filePath, JSON.stringify(fileContent, null, 2));

		return { count: tags.length, files: [filePath], missingIds: [] };
	}

	async exportWorkflowsToWorkFolder(
		candidates: SourceControlledFile[],
	): Promise<SourceControlExportResult> {
		const candidateIds = candidates.map((candidate) => candidate.id);
		const workflows = await this.workflowRepository.findByIdsWithParentFolder(candidateIds);
		const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
		const ownersById = await this.resolveWorkflowOwners(candidateIds);

		await mkdir(path.join(this.gitFolder, SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER), {
			recursive: true,
		});

		const files: string[] = [];
		const missingIds: string[] = [];
		for (const candidateId of candidateIds) {
			const workflow = workflowsById.get(candidateId);
			if (!workflow) {
				missingIds.push(candidateId);
				continue;
			}
			const exportable = this.toExportableWorkflow(workflow, ownersById.get(workflow.id));
			const filePath = this.getWorkflowPath(workflow.id);
			await assertNotSymlink(filePath);
			await writeFile(filePath, JSON.stringify(exportable, null, 2));
			files.push(filePath);
		}

		return { count: files.length, files, missingIds };
	}

	async exportFoldersToWorkFolder(
		context: SourceControlContext,
	): Promise<SourceControlExportResult> {
		await mkdir(this.gitFolder, { recursive: true });

		let folders: ExportableFolder[];
		if (context.hasAccessToAllProjects()) {
			folders = (await this.folderRepository.findManyWithHomeProject()).map((folder) =>
				this.toExportableFolder(folder),
			);
		} else {
			const authorizedProjectIds = context.getAuthorizedProjectIds() ?? [];
			const inScope = (
				await this.folderRepository.findManyWithHomeProject(authorizedProjectIds)
			).map((folder) => this.toExportableFolder(folder));
			// Preserve folders owned by projects outside the caller's scope;
			// only the caller's complete in-scope folder set is replaced.
			const authorized = new Set(authorizedProjectIds);
			const existing = await this.readFoldersFile();
			const preserved = existing.folders.filter((folder) => !authorized.has(folder.homeProjectId));
			folders = [...preserved, ...inScope];
		}

		const filePath = this.getFoldersPath();
		const fileContent: FolderExportFile = { folders };
		await assertNotSymlink(filePath);
		await writeFile(filePath, JSON.stringify(fileContent, null, 2));

		return { count: folders.length, files: [filePath], missingIds: [] };
	}

	async exportDataTablesToWorkFolder(
		candidates: SourceControlledFile[],
	): Promise<SourceControlExportResult> {
		const candidateIds = candidates.map((candidate) => candidate.id);
		const dataTables =
			candidateIds.length > 0
				? await this.dataTableRepository.getMany({ filter: { id: candidateIds } })
				: [];
		const dataTablesById = new Map(dataTables.map((dataTable) => [dataTable.id, dataTable]));

		const personalProjectIds = dataTables
			.filter((dataTable) => dataTable.project?.type === 'personal')
			.map((dataTable) => dataTable.project.id);
		const emailByProjectId = await this.getPersonalProjectOwnerEmails(personalProjectIds);

		await mkdir(path.join(this.gitFolder, SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER), {
			recursive: true,
		});

		const files: string[] = [];
		const missingIds: string[] = [];
		for (const candidateId of candidateIds) {
			const dataTable = dataTablesById.get(candidateId);
			if (!dataTable) {
				missingIds.push(candidateId);
				continue;
			}
			const exportable = this.toExportableDataTable(dataTable, emailByProjectId);
			const filePath = this.getDataTablePath(dataTable.id);
			await assertNotSymlink(filePath);
			await writeFile(filePath, JSON.stringify(exportable, null, 2));
			files.push(filePath);
		}

		return { count: files.length, files, missingIds };
	}

	private async getExportableTagMappings(
		context: SourceControlContext,
	): Promise<Array<{ tagId: string; workflowId: string }>> {
		if (context.hasAccessToAllProjects()) {
			return (await this.workflowTagMappingRepository.findAllMappings()).map(
				({ tagId, workflowId }) => ({ tagId, workflowId }),
			);
		}

		const authorizedProjectIds = context.getAuthorizedProjectIds() ?? [];
		const inScopeWorkflowIds =
			await this.sharedWorkflowRepository.findWorkflowIdsOwnedByProjects(authorizedProjectIds);
		const inScope = new Set(inScopeWorkflowIds);

		// Preserve mappings of out-of-scope workflows from the previously
		// exported file; only in-scope mappings are refreshed from the database.
		const existing = await this.readTagsFile();
		const preserved = existing.mappings.filter((mapping) => !inScope.has(mapping.workflowId));
		const refreshed = (
			await this.workflowTagMappingRepository.findMappingsForWorkflows(inScopeWorkflowIds)
		).map(({ tagId, workflowId }) => ({ tagId, workflowId }));

		return [...preserved, ...refreshed];
	}

	private async readTagsFile(): Promise<TagsExportFile> {
		const fallback: TagsExportFile = { tags: [], mappings: [] };
		try {
			await assertNotSymlink(this.getTagsPath());
			const content = await readFile(this.getTagsPath(), { encoding: 'utf8' });
			return jsonParse<TagsExportFile>(content, { fallbackValue: fallback });
		} catch {
			return fallback;
		}
	}

	private async readFoldersFile(): Promise<FolderExportFile> {
		const fallback: FolderExportFile = { folders: [] };
		try {
			await assertNotSymlink(this.getFoldersPath());
			const content = await readFile(this.getFoldersPath(), { encoding: 'utf8' });
			return jsonParse<FolderExportFile>(content, { fallbackValue: fallback });
		} catch {
			return fallback;
		}
	}

	private async resolveCredentialOwners(
		credentials: CredentialsEntity[],
	): Promise<Map<string, StructuredResourceOwner | null>> {
		const ownerProjects = new Map<string, Project>();
		for (const credential of credentials) {
			const ownerSharing = credential.shared?.find(
				(sharing) => sharing.role === 'credential:owner',
			);
			if (ownerSharing?.project) ownerProjects.set(credential.id, ownerSharing.project);
		}

		const personalProjectIds = [...ownerProjects.values()]
			.filter((project) => project.type === 'personal')
			.map((project) => project.id);
		const emailByProjectId = await this.getPersonalProjectOwnerEmails(personalProjectIds);

		const owners = new Map<string, StructuredResourceOwner | null>();
		for (const credential of credentials) {
			const project = ownerProjects.get(credential.id);
			owners.set(
				credential.id,
				project ? this.toResourceOwner(project, emailByProjectId.get(project.id)) : null,
			);
		}
		return owners;
	}

	private async resolveWorkflowOwners(
		workflowIds: string[],
	): Promise<Map<string, StructuredResourceOwner>> {
		if (workflowIds.length === 0) return new Map();

		const ownerSharings = await this.sharedWorkflowRepository.findByWorkflowIds(workflowIds);
		const owners = new Map<string, StructuredResourceOwner>();
		for (const sharing of ownerSharings) {
			const project = sharing.project;
			if (!project) continue;
			const personalEmail = project.projectRelations?.find(
				(relation) => relation.role?.slug === PROJECT_OWNER_ROLE_SLUG,
			)?.user?.email;
			const owner = this.toResourceOwner(project, personalEmail);
			if (owner) owners.set(sharing.workflowId, owner);
		}
		return owners;
	}

	private async getPersonalProjectOwnerEmails(projectIds: string[]): Promise<Map<string, string>> {
		const uniqueProjectIds = [...new Set(projectIds)];
		if (uniqueProjectIds.length === 0) return new Map();
		const relations =
			await this.projectRelationRepository.getPersonalProjectOwners(uniqueProjectIds);
		return new Map(relations.map((relation) => [relation.projectId, relation.user.email]));
	}

	private toResourceOwner(
		project: Project,
		personalEmail: string | undefined,
	): StructuredResourceOwner | null {
		if (project.type === 'team') {
			return { type: 'team', teamId: project.id, teamName: project.name };
		}
		// A personal project without a resolvable owner (e.g. deleted user)
		// cannot be serialized as a structured personal owner.
		if (personalEmail === undefined) return null;
		return {
			type: 'personal',
			projectId: project.id,
			projectName: project.name,
			personalEmail,
		};
	}

	private async toExportableCredential(
		credential: CredentialsEntity,
		ownedBy: StructuredResourceOwner | null,
	): Promise<ExportableCredential> {
		// decryptV2 is the canonical read path for stored credential data — see
		// `Credentials.getData()` in n8n-core.
		const decrypted = jsonParse<Record<string, unknown>>(
			await this.cipher.decryptV2(credential.data),
		);

		return {
			id: credential.id,
			name: credential.name,
			type: credential.type,
			data: this.sanitizeCredentialData(decrypted),
			ownedBy,
			isGlobal: credential.isGlobal ?? false,
			...(credential.isResolvable
				? {
						isResolvable: true,
						resolvableAllowFallback: credential.resolvableAllowFallback ?? false,
					}
				: {}),
		};
	}

	/**
	 * Strip secrets while keeping enough structure for the import side to
	 * reconcile: strings become `''`, non-string primitives survive (they are
	 * settings, not secrets), nesting is preserved recursively, and
	 * `oauthTokenData` is omitted entirely.
	 */
	private sanitizeCredentialData(data: object): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (key === 'oauthTokenData') continue;
			sanitized[key] = this.sanitizeCredentialValue(value);
		}
		return sanitized;
	}

	private sanitizeCredentialValue(value: unknown): unknown {
		if (typeof value === 'string') return '';
		if (Array.isArray(value)) return value.map((entry) => this.sanitizeCredentialValue(entry));
		if (value !== null && typeof value === 'object') return this.sanitizeCredentialData(value);
		return value;
	}

	private toExportableWorkflow(
		workflow: WorkflowEntity,
		owner: StructuredResourceOwner | undefined,
	): ExportableWorkflow {
		return {
			id: workflow.id,
			name: workflow.name,
			connections: workflow.connections,
			isArchived: workflow.isArchived,
			nodes: workflow.nodes,
			...(owner ? { owner } : {}),
			triggerCount: workflow.triggerCount ?? 0,
			parentFolderId: workflow.parentFolder?.id ?? null,
			versionId: workflow.versionId,
			nodeGroups: workflow.nodeGroups ?? [],
		};
	}

	private toExportableFolder(folder: Folder): ExportableFolder {
		return {
			id: folder.id,
			name: folder.name,
			homeProjectId: folder.homeProject.id,
			parentFolderId: folder.parentFolderId ?? null,
			createdAt: folder.createdAt.toISOString(),
			updatedAt: folder.updatedAt.toISOString(),
		};
	}

	private toExportableDataTable(
		dataTable: DataTable,
		personalEmailByProjectId: Map<string, string>,
	): ExportableDataTable {
		const columns = [...(dataTable.columns ?? [])]
			.sort((a, b) => a.index - b.index)
			.map((column) => ({
				id: column.id,
				name: column.name,
				type: column.type,
				index: column.index,
			}));

		return {
			id: dataTable.id,
			name: dataTable.name,
			columns,
			ownedBy: dataTable.project
				? this.toResourceOwner(
						dataTable.project,
						personalEmailByProjectId.get(dataTable.project.id),
					)
				: null,
			createdAt: dataTable.createdAt.toISOString(),
			updatedAt: dataTable.updatedAt.toISOString(),
		};
	}
}
