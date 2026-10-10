import { createPinia, setActivePinia } from 'pinia';

import type { ProjectSharingData } from '@/features/collaboration/projects/projects.types';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';

import { useEnvironmentsStore } from './environments.store';
import type { EnvironmentVariable } from './environments.types';

const variable = (key: string, value: string, projectId?: string): EnvironmentVariable => ({
	id: `${key}-${projectId ?? 'global'}`,
	key,
	value,
	project: projectId ? { id: projectId, name: projectId } : null,
});

const VARIABLES = [
	variable('region', 'global-region'),
	variable('token', 'global-token'),
	variable('region', 'alpha-region', 'alpha'),
	variable('only-beta', 'beta-value', 'beta'),
];

describe('environments store $vars scoping', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	const openWorkflowInProject = (projectId: string | null) => {
		const workflowsStore = useWorkflowsStore();
		workflowsStore.setWorkflowId('wf-1');
		useWorkflowDocumentStore(createWorkflowDocumentId('wf-1')).setHomeProject(
			projectId ? ({ id: projectId, name: projectId, type: 'team' } as ProjectSharingData) : null,
		);
	};

	test("resolves the open workflow's project variables over globals, ignoring other projects", () => {
		const store = useEnvironmentsStore();
		store.setVariables(VARIABLES);
		openWorkflowInProject('alpha');

		expect(store.variablesAsObject).toEqual({ region: 'alpha-region', token: 'global-token' });
		expect(store.scopedVariables.map((v) => v.id).sort()).toEqual(
			['region-alpha', 'region-global', 'token-global'].sort(),
		);
	});

	test('a workflow without a home project sees only global variables', () => {
		const store = useEnvironmentsStore();
		store.setVariables(VARIABLES);
		openWorkflowInProject(null);

		expect(store.variablesAsObject).toEqual({ region: 'global-region', token: 'global-token' });
	});

	test('resolves for an explicit project, independent of the open workflow', () => {
		const store = useEnvironmentsStore();
		store.setVariables(VARIABLES);
		openWorkflowInProject('alpha');

		expect(store.variablesAsObjectForProject('beta')).toEqual({
			region: 'global-region',
			token: 'global-token',
			'only-beta': 'beta-value',
		});
	});
});
