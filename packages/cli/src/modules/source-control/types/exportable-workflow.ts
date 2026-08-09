import type { IConnections, INode, IWorkflowGroup } from 'n8n-workflow';

import type { RemoteResourceOwner } from './resource-owner';

/** A workflow as serialized to `workflows/<id>.json`. */
export interface ExportableWorkflow {
	id: string;
	name: string;
	connections: IConnections;
	isArchived: boolean;
	nodes: INode[];
	owner?: RemoteResourceOwner;
	triggerCount: number;
	parentFolderId: string | null;
	versionId: string;
	nodeGroups: IWorkflowGroup[];
}
