import type { INode } from 'n8n-workflow';

/** Ids of every credential the workflow's nodes reference, deduplicated. */
export function collectCredentialIds(nodes: INode[]): string[] {
	const ids = new Set<string>();
	for (const node of nodes) {
		for (const credential of Object.values(node.credentials ?? {})) {
			if (credential.id) ids.add(credential.id);
		}
	}
	return [...ids];
}
