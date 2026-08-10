import type { IWorkflowDb } from '@/Interface';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * Workflow sharing & transfer API calls.
 *
 * Backend routes (see cli `workflows.controller` / `folder.controller`):
 * - PUT /workflows/:workflowId/share    { shareWithIds }
 * - PUT /workflows/:workflowId/transfer { destinationProjectId, ... }
 * - PUT /projects/:projectId/folders/:folderId/transfer { destinationProjectId, ... }
 */

export async function setWorkflowSharedWith(
	context: IRestApiContext,
	workflowId: string,
	data: { shareWithIds: string[] },
): Promise<IWorkflowDb> {
	return await makeRestApiRequest<IWorkflowDb>(
		context,
		'PUT',
		`/workflows/${workflowId}/share`,
		data,
	);
}

export async function moveWorkflowToProject(
	context: IRestApiContext,
	workflowId: string,
	body: {
		destinationProjectId: string;
		destinationParentFolderId?: string;
		shareCredentials?: string[];
	},
): Promise<void> {
	await makeRestApiRequest(context, 'PUT', `/workflows/${workflowId}/transfer`, body);
}

export async function moveFolderToProject(
	context: IRestApiContext,
	projectId: string,
	folderId: string,
	destinationProjectId: string,
	destinationParentFolderId?: string,
	shareCredentials?: string[],
): Promise<void> {
	await makeRestApiRequest(context, 'PUT', `/projects/${projectId}/folders/${folderId}/transfer`, {
		destinationProjectId,
		destinationParentFolderId,
		shareCredentials,
	});
}
