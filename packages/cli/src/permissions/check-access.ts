import type { EntityManager, User } from '@n8n/db';
import {
	ProjectRelationRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { hasGlobalScope, type Scope } from '@n8n/permissions';
import { UnexpectedError } from 'n8n-workflow';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { RoleService } from '@/services/role.service';

/**
 * Check whether a user holds all the given scopes, either globally or within
 * the project tied to the resource identified in `context`.
 *
 * Resolution order:
 * 1. The user's global role grants all scopes → `true`.
 * 2. `globalOnly` is set → `false` (project-level grants must not satisfy it).
 * 3. Otherwise the scopes must all be granted by the user's role in the
 *    project owning the resource (`projectId`, `workflowId`, `credentialId`,
 *    or `dataTableId`). Workflows and credentials additionally require a
 *    sufficient sharing role on the resource↔project relation itself.
 *
 * @throws {NotFoundError} when a referenced resource does not exist at all,
 *   so callers can answer 404 instead of 403.
 */
export async function userHasScopes(
	user: User,
	scopes: Scope[],
	globalOnly: boolean,
	context: {
		credentialId?: string;
		workflowId?: string;
		projectId?: string;
		dataTableId?: string;
	},
	trx?: EntityManager,
): Promise<boolean> {
	if (hasGlobalScope(user, scopes, { mode: 'allOf' })) return true;

	if (globalOnly) return false;

	const { credentialId, workflowId, projectId, dataTableId } = context;

	// Roles (static + custom) whose scope set contains ALL required scopes,
	// then the projects where the user holds one of those roles.
	const roleService = Container.get(RoleService);
	const projectRoles = await roleService.rolesWithScope('project', scopes, trx);
	const userProjectIds = await Container.get(
		ProjectRelationRepository,
	).getAccessibleProjectsByRoles(user.id, projectRoles, trx);

	if (projectId) return userProjectIds.includes(projectId);

	if (workflowId) {
		const workflowRoles = await roleService.rolesWithScope('workflow', scopes, trx);
		const relations = await Container.get(SharedWorkflowRepository).getAllRelationsForWorkflows(
			[workflowId],
			trx,
		);
		if (relations.length === 0) {
			throw new NotFoundError(`Workflow with ID "${workflowId}" does not exist.`);
		}
		return relations.some(
			(relation) =>
				workflowRoles.includes(relation.role) && userProjectIds.includes(relation.projectId),
		);
	}

	if (credentialId) {
		const credentialRoles = await roleService.rolesWithScope('credential', scopes, trx);
		const relations = await Container.get(
			SharedCredentialsRepository,
		).getAllRelationsForCredentials([credentialId], trx);
		if (relations.length === 0) {
			throw new NotFoundError(`Credential with ID "${credentialId}" does not exist.`);
		}
		return relations.some(
			(relation) =>
				credentialRoles.includes(relation.role) && userProjectIds.includes(relation.projectId),
		);
	}

	if (dataTableId) {
		const dataTable = await Container.get(DataTableRepository).findOneBy({ id: dataTableId });
		if (!dataTable) {
			throw new NotFoundError(`Data table with ID "${dataTableId}" does not exist.`);
		}
		return userProjectIds.includes(dataTable.projectId);
	}

	throw new UnexpectedError(
		'`userHasScopes` was called without a `credentialId`, `workflowId`, `projectId`, or `dataTableId` in its context. This is likely an implementation error: check that the route defines one of these URL parameters, or use a global-only scope check instead.',
	);
}
