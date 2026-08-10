import type { User } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	TransactionRunner,
	WorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import type { INode } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { CredentialsService } from '@/credentials/credentials.service';
import { FolderNotFoundError } from '@/errors/folder-not-found.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { OwnershipService } from '@/services/ownership.service';
import { ProjectService } from '@/services/project.service';

import { WorkflowFinderService } from './workflow-finder.service';
import { WorkflowMutationHooksProxy } from './workflow-mutation-hooks-proxy.service';

const PROJECT_ROOT_FOLDER = '0';

type ProjectSummary = {
	id: string;
	type: string;
	name: string;
	icon: { type: 'emoji' | 'icon'; value: string } | null;
};

export type UsedCredential = {
	id: string;
	name: string;
	credentialType: string;
	currentUserHasAccess: boolean;
	homeProject?: ProjectSummary | null;
	sharedWithProjects?: ProjectSummary[];
};

/** The `{ id }` credential references found in a set of workflow nodes. */
function collectCredentialIds(nodes: INode[] | undefined): Set<string> {
	const ids = new Set<string>();
	for (const node of nodes ?? []) {
		for (const credential of Object.values(node.credentials ?? {})) {
			if (credential.id) ids.add(credential.id);
		}
	}
	return ids;
}

function toProjectSummary(project: {
	id: string;
	type: string;
	name: string;
	icon: { type: 'emoji' | 'icon'; value: string } | null;
}): ProjectSummary {
	return { id: project.id, type: project.type, name: project.name, icon: project.icon };
}

/**
 * Sharing-aware workflow operations: owner/sharing metadata for responses,
 * credential-access enrichment and tamper guards for shared editing, and
 * workflow/folder transfers between projects.
 */
@Service()
export class EnterpriseWorkflowService {
	constructor(
		private readonly workflowRepository: WorkflowRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly folderRepository: FolderRepository,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly credentialsService: CredentialsService,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly projectService: ProjectService,
		private readonly activeWorkflowManager: ActiveWorkflowManager,
		private readonly ownershipService: OwnershipService,
		private readonly workflowMutationHooks: WorkflowMutationHooksProxy,
		private readonly transactionRunner: TransactionRunner,
	) {}

	/**
	 * Attach `homeProject` / `sharedWithProjects` derived from the workflow's
	 * loaded `shared` relations. The `shared` property itself is left in place —
	 * callers strip it before responding.
	 */
	addOwnerAndSharings<
		T extends {
			shared?: Array<{ role: string; project: ProjectSummary & Record<string, unknown> }>;
		},
	>(workflow: T): T & { homeProject: ProjectSummary | null; sharedWithProjects: ProjectSummary[] } {
		const enriched = workflow as T & {
			homeProject: ProjectSummary | null;
			sharedWithProjects: ProjectSummary[];
			usedCredentials?: UsedCredential[];
		};
		enriched.homeProject = null;
		enriched.sharedWithProjects = [];
		// Filled in by `addCredentialsToWorkflow` on detail reads; create
		// responses carry the empty list.
		enriched.usedCredentials ??= [];

		for (const sharing of workflow.shared ?? []) {
			if (sharing.role === 'workflow:owner') {
				enriched.homeProject = toProjectSummary(sharing.project);
			} else {
				enriched.sharedWithProjects.push(toProjectSummary(sharing.project));
			}
		}

		return enriched;
	}

	/** Attach `usedCredentials`: every credential the workflow references, with access info for the user. */
	async addCredentialsToWorkflow(
		workflow: { nodes?: INode[] } & { usedCredentials?: UsedCredential[] },
		user: User,
	): Promise<void> {
		const referencedIds = [...collectCredentialIds(workflow.nodes)];
		if (referencedIds.length === 0) {
			workflow.usedCredentials = [];
			return;
		}

		const [referenced, accessible] = await Promise.all([
			this.credentialsRepository.getManyByIds(referencedIds, { withSharings: true }),
			this.credentialsFinderService.findAllCredentialsForUser(user, ['credential:read']),
		]);
		const accessibleIds = new Set(accessible.map((credential) => credential.id));

		workflow.usedCredentials = referenced.map((credential) => {
			const used: UsedCredential = {
				id: credential.id,
				name: credential.name,
				credentialType: credential.type,
				currentUserHasAccess: accessibleIds.has(credential.id),
				homeProject: null,
				sharedWithProjects: [],
			};
			for (const sharing of credential.shared ?? []) {
				if (sharing.role === 'credential:owner') {
					used.homeProject = toProjectSummary(sharing.project);
				} else {
					used.sharedWithProjects!.push(toProjectSummary(sharing.project));
				}
			}
			return used;
		});
	}

	/** @throws {UserError} when the workflow references a credential outside the given accessible set. */
	validateCredentialPermissionsToUser(
		workflow: { nodes?: INode[] },
		allowedCredentials: Array<{ id: string }>,
	): void {
		const allowedIds = new Set(allowedCredentials.map((credential) => credential.id));
		for (const credentialId of collectCredentialIds(workflow.nodes)) {
			if (!allowedIds.has(credentialId)) {
				throw new UserError('The workflow contains credentials that you do not have access to');
			}
		}
	}

	/**
	 * Guard for every workflow write path with sharing enabled: reject nodes
	 * that newly reference credentials the acting user cannot access, and
	 * revert edits to existing nodes whose (inaccessible) credentials make
	 * them read-only for this user. Returns the possibly-adjusted update data.
	 */
	async preventTampering<T extends { nodes?: INode[] }>(
		workflowUpdateData: T,
		workflowId: string,
		user: User,
	): Promise<T> {
		if (!workflowUpdateData.nodes) return workflowUpdateData;

		const previousVersion = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!previousVersion) {
			throw new NotFoundError(`Workflow with ID "${workflowId}" does not exist`);
		}

		const accessible = await this.credentialsService.getCredentialsAUserCanUseInAWorkflow(user, {
			workflowId,
		});
		const accessibleIds = new Set(accessible.map((credential) => credential.id));
		const previousNodeById = new Map(previousVersion.nodes.map((node) => [node.id, node]));

		workflowUpdateData.nodes = workflowUpdateData.nodes.map((node) => {
			const inaccessible = [...collectCredentialIds([node])].filter((id) => !accessibleIds.has(id));
			if (inaccessible.length === 0) return node;

			const previousNode = previousNodeById.get(node.id);
			const previousCredentialIds = previousNode
				? collectCredentialIds([previousNode])
				: new Set<string>();
			const isTampering = inaccessible.some((id) => !previousCredentialIds.has(id));

			if (isTampering || !previousNode) {
				throw new BadRequestError(
					`You don't have access to the credentials in the '${node.name}' node. Ask the owner to share them with you.`,
				);
			}

			// The node already used this inaccessible credential: it is read-only
			// for this user, so any edits to it are reverted.
			return previousNode;
		});

		return workflowUpdateData;
	}

	/** IDs (as a Set) of the given workflows that reference resolvable (per-user) credentials. */
	async getWorkflowIdsWithResolvableCredentials(workflowIds: string[]): Promise<Set<string>> {
		return new Set(await this.workflowRepository.findIdsWithResolvableCredentials(workflowIds));
	}

	/** Share the workflow into the given projects with the `workflow:editor` role. */
	async shareWithProjects(
		workflowId: string,
		shareWithProjectIds: string[],
		entityManager?: Parameters<SharedWorkflowRepository['shareWithProjects']>[2],
	) {
		await this.sharedWorkflowRepository.shareWithProjects(
			workflowId,
			shareWithProjectIds,
			entityManager,
		);
	}

	/**
	 * Move a workflow to another project. The caller needs `workflow:move` on
	 * the workflow and `workflow:create` in the destination. All sharings are
	 * replaced by destination ownership; active workflows are deactivated for
	 * the move and reactivated afterwards (deactivated permanently if
	 * reactivation fails).
	 */
	async transferWorkflow(
		user: User,
		workflowId: string,
		destinationProjectId: string,
		shareCredentials: string[] = [],
		destinationParentFolderId?: string,
	): Promise<void> {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
			'workflow:move',
		]);
		if (!workflow) {
			throw new NotFoundError(`Could not find workflow with the id "${workflowId}".`);
		}

		const ownerSharing = workflow.shared?.find((sharing) => sharing.role === 'workflow:owner');
		if (ownerSharing?.projectId === destinationProjectId) {
			throw new BadRequestError(
				'The workflow is already owned by the destination project. It cannot be transferred to itself.',
			);
		}

		const destinationProject = await this.projectService.getProjectWithScope(
			user,
			destinationProjectId,
			['workflow:create'],
		);
		if (!destinationProject) {
			throw new NotFoundError(`Could not find project to transfer to. ID: ${destinationProjectId}`);
		}

		const destinationFolder = await this.resolveDestinationFolder(
			destinationParentFolderId,
			destinationProjectId,
		);

		const wasActive = workflow.active;
		if (wasActive) {
			await this.activeWorkflowManager.remove(workflowId);
		}

		// Ownership, re-homing and the modules' project-scoped state move as one
		// unit: a failure part-way through must not leave a module still holding
		// state for the source project while the destination project owns the
		// workflow. The owning project really did change (a self-transfer is
		// rejected above), so the hook always applies.
		await this.transactionRunner.run({}, async (ctx) => {
			await this.sharedWorkflowRepository.transferOwnership(workflowId, destinationProjectId, ctx);
			// The old parent folder belongs to the source project — always re-home.
			await this.workflowRepository.updateParentFolder(workflowId, destinationFolder, ctx);
			await this.workflowMutationHooks.duringWorkflowsTransferred([workflowId], ctx);
		});

		await this.ownershipService.invalidateWorkflowProjectCacheByIds([workflowId]);

		await this.shareShareableCredentialsWithProject(user, shareCredentials, destinationProjectId);

		await this.workflowMutationHooks.afterWorkflowsTransferred([workflowId]);

		if (wasActive) {
			await this.activeWorkflowManager.add(workflowId, 'update');
		}
	}

	/**
	 * Move a folder (and its whole subtree, including all contained workflows)
	 * to another project. Every workflow in the subtree must be owned by the
	 * source project.
	 */
	async transferFolder(
		user: User,
		sourceProjectId: string,
		sourceFolderId: string,
		destinationProjectId: string,
		destinationParentFolderId: string,
		shareCredentials: string[] = [],
	): Promise<void> {
		if (sourceProjectId === destinationProjectId) {
			throw new BadRequestError(
				'The folder is already in this project. It cannot be transferred to the project it is already in.',
			);
		}

		const folder = await this.folderRepository.findOneBy({
			id: sourceFolderId,
			homeProject: { id: sourceProjectId },
		});
		if (!folder) {
			throw new FolderNotFoundError(sourceFolderId);
		}

		const destinationProject = await this.projectService.getProjectWithScope(
			user,
			destinationProjectId,
			['workflow:create'],
		);
		if (!destinationProject) {
			throw new NotFoundError(`Could not find project to transfer to. ID: ${destinationProjectId}`);
		}

		const destinationFolder = await this.resolveDestinationFolder(
			destinationParentFolderId,
			destinationProjectId,
		);

		const subtreeFolderIds = [
			sourceFolderId,
			...(await this.folderRepository.getAllFolderIdsInHierarchy(sourceFolderId, sourceProjectId)),
		];
		const workflows = await this.workflowRepository.findByParentFolderIds(subtreeFolderIds);

		// Every contained workflow must be owned by the source project; a foreign
		// workflow in the tree would silently change ownership on transfer.
		if (workflows.length > 0) {
			const relations = await this.sharedWorkflowRepository.getAllRelationsForWorkflows(
				workflows.map((workflow) => workflow.id),
			);
			const foreign = workflows.filter(
				(workflow) =>
					!relations.some(
						(relation) =>
							relation.workflowId === workflow.id &&
							relation.role === 'workflow:owner' &&
							relation.projectId === sourceProjectId,
					),
			);
			if (foreign.length > 0) {
				throw new BadRequestError(
					'The folder contains workflows that are not owned by this project, so it cannot be transferred.',
				);
			}
		}

		const activeWorkflowIds: string[] = [];
		for (const workflow of workflows) {
			if (workflow.active) {
				activeWorkflowIds.push(workflow.id);
				await this.activeWorkflowManager.remove(workflow.id);
			}
		}

		const workflowIds = workflows.map((workflow) => workflow.id);

		// Same as the single-workflow move: source and destination projects differ
		// (guarded above), so every workflow in the subtree changed owner, and the
		// modules' project-scoped state must change with it or not at all.
		await this.transactionRunner.run({}, async (ctx) => {
			for (const workflowId of workflowIds) {
				await this.sharedWorkflowRepository.transferOwnership(
					workflowId,
					destinationProjectId,
					ctx,
				);
			}

			// Re-home the whole subtree; only the transferred root changes parent.
			await this.folderRepository.moveFoldersToProject(subtreeFolderIds, destinationProjectId, ctx);
			await this.folderRepository.updateParentFolder(sourceFolderId, destinationFolder, ctx);
			await this.workflowMutationHooks.duringWorkflowsTransferred(workflowIds, ctx);
		});

		await this.ownershipService.invalidateWorkflowProjectCacheByIds(workflowIds);

		await this.shareShareableCredentialsWithProject(user, shareCredentials, destinationProjectId);

		await this.workflowMutationHooks.afterWorkflowsTransferred(workflowIds);

		for (const workflowId of activeWorkflowIds) {
			await this.activeWorkflowManager.add(workflowId, 'update');
		}
	}

	/** The credentials used by workflows in the folder subtree, with access info for the user. */
	async getFolderUsedCredentials(
		user: User,
		folderId: string,
		projectId: string,
	): Promise<UsedCredential[]> {
		const folder = await this.folderRepository.findOneBy({
			id: folderId,
			homeProject: { id: projectId },
		});
		if (!folder) {
			throw new FolderNotFoundError(folderId);
		}

		const subtreeFolderIds = [
			folderId,
			...(await this.folderRepository.getAllFolderIdsInHierarchy(folderId, projectId)),
		];
		const workflows = await this.workflowRepository.findByParentFolderIds(subtreeFolderIds);

		const carrier: { nodes: INode[]; usedCredentials?: UsedCredential[] } = {
			nodes: workflows.flatMap((workflow) => workflow.nodes ?? []),
		};
		await this.addCredentialsToWorkflow(carrier, user);
		return carrier.usedCredentials ?? [];
	}

	/** Resolve a destination parent folder ('0'/undefined = project root → null). */
	private async resolveDestinationFolder(
		destinationParentFolderId: string | undefined,
		destinationProjectId: string,
	) {
		if (!destinationParentFolderId || destinationParentFolderId === PROJECT_ROOT_FOLDER) {
			return null;
		}
		const destinationFolder = await this.folderRepository.findOneBy({
			id: destinationParentFolderId,
			homeProject: { id: destinationProjectId },
		});
		if (!destinationFolder) {
			throw new BadRequestError(
				`The destination folder with ID "${destinationParentFolderId}" does not exist in the destination project.`,
			);
		}
		return destinationFolder;
	}

	/**
	 * Share the credentials the user is allowed to SHARE into the project (as
	 * `credential:user`). Credentials the user can merely use are skipped
	 * silently — a transfer must not escalate a use-grant into a share.
	 */
	private async shareShareableCredentialsWithProject(
		user: User,
		credentialIds: string[],
		projectId: string,
	) {
		for (const credentialId of credentialIds) {
			const credential = await this.credentialsFinderService.findCredentialForUser(
				credentialId,
				user,
				['credential:share'],
			);
			if (credential) {
				await this.sharedCredentialsRepository.shareWithProjects(credentialId, [projectId]);
			}
		}
	}
}
