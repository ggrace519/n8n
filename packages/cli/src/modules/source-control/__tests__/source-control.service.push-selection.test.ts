import type { SourceControlledFile } from '@n8n/api-types';
import { mockInstance } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { ForbiddenError } from '@/errors/response-errors/forbidden.error';

import { SourceControlContext } from '../source-control-context.factory';
import type { SourceControlContextFactory } from '../source-control-context.factory';
import type { SourceControlExportService } from '../source-control-export.service';
import type { SourceControlGitService } from '../source-control-git.service';
import type { SourceControlPreferencesService } from '../source-control-preferences.service';
import type { SourceControlStatusService } from '../source-control-status.service';
import { SourceControlService } from '../source-control.service';

mockInstance(InstanceSettings, { n8nFolder: '/tmp/source-control-push-selection-test' });

const user = mock<User>({ id: 'user-1' });

const freshWorkflowEntry: SourceControlledFile = {
	id: 'wf-1',
	name: 'Workflow 1',
	type: 'workflow',
	status: 'modified',
	location: 'local',
	conflict: false,
	file: '/server/derived/workflows/wf-1.json',
	updatedAt: '2026-01-01T00:00:00.000Z',
	owner: { type: 'team', projectId: 'project-a', projectName: 'Project A' },
};

const freshDeletedEntry: SourceControlledFile = {
	id: 'wf-gone',
	name: 'Removed Workflow',
	type: 'workflow',
	status: 'deleted',
	location: 'remote',
	conflict: false,
	file: '/server/derived/workflows/wf-gone.json',
	updatedAt: '2026-01-01T00:00:00.000Z',
	owner: { type: 'team', projectId: 'project-a', projectName: 'Project A' },
};

describe('SourceControlService push candidate selection', () => {
	let service: SourceControlService;
	let gitService: ReturnType<typeof mock<SourceControlGitService>>;
	let statusService: ReturnType<typeof mock<SourceControlStatusService>>;
	let exportService: ReturnType<typeof mock<SourceControlExportService>>;
	let preferencesService: ReturnType<typeof mock<SourceControlPreferencesService>>;
	let contextFactory: ReturnType<typeof mock<SourceControlContextFactory>>;

	beforeEach(() => {
		gitService = mock<SourceControlGitService>();
		statusService = mock<SourceControlStatusService>();
		exportService = mock<SourceControlExportService>();
		preferencesService = mock<SourceControlPreferencesService>();
		contextFactory = mock<SourceControlContextFactory>();

		preferencesService.getPreferences.mockReturnValue({
			connected: true,
			repositoryUrl: 'git@example.com:org/repo.git',
			branchName: 'main',
			branchReadOnly: false,
			branchColor: '#000000',
			publicKey: '',
			initRepo: false,
			keyGeneratorType: 'rsa',
		});
		contextFactory.createContext.mockResolvedValue(new SourceControlContext(user, ['project-a']));
		statusService.getStatus.mockResolvedValue([freshWorkflowEntry, freshDeletedEntry]);
		gitService.commit.mockResolvedValue(
			mock({ commit: 'abc123', summary: { changes: 1, insertions: 1, deletions: 0 } }),
		);
		exportService.exportWorkflowsToWorkFolder.mockResolvedValue({
			count: 1,
			files: [freshWorkflowEntry.file],
			missingIds: [],
		});

		service = new SourceControlService(
			mock(),
			gitService,
			preferencesService,
			exportService,
			mock(),
			contextFactory,
			mock(),
			mock(),
			statusService,
		);
		service.sanityCheck = async () => {};
	});

	it('rejects a selection that is not part of the fresh scoped status', async () => {
		const forged: SourceControlledFile = {
			...freshWorkflowEntry,
			id: 'not-in-status',
			file: '/etc/passwd',
		};

		await expect(
			service.pushWorkfolder(user, { fileNames: [forged], commitMessage: 'x' }),
		).rejects.toThrow(ForbiddenError);

		expect(exportService.exportWorkflowsToWorkFolder).not.toHaveBeenCalled();
		expect(gitService.stage).not.toHaveBeenCalled();
		expect(gitService.commit).not.toHaveBeenCalled();
		expect(gitService.push).not.toHaveBeenCalled();
	});

	it('replaces client-supplied entries with the server-side status entries', async () => {
		const tampered: SourceControlledFile = {
			...freshWorkflowEntry,
			// Client claims a hostile path and a deleted status for a real id.
			file: '/etc/passwd',
			status: 'deleted',
		};

		const result = await service.pushWorkfolder(user, {
			fileNames: [tampered],
			commitMessage: 'x',
		});

		// The export received the server-side entry, not the client one.
		expect(exportService.exportWorkflowsToWorkFolder).toHaveBeenCalledWith([freshWorkflowEntry]);
		// Nothing was staged for deletion — the client-claimed status is ignored.
		expect(gitService.stage).toHaveBeenCalledWith(new Set([freshWorkflowEntry.file]), new Set());
		expect(result.statusResult).toEqual([freshWorkflowEntry]);
	});

	it('stages deletions only from server-side deleted entries', async () => {
		const result = await service.pushWorkfolder(user, {
			fileNames: [freshWorkflowEntry, freshDeletedEntry],
			commitMessage: 'x',
		});

		expect(gitService.stage).toHaveBeenCalledWith(
			new Set([freshWorkflowEntry.file]),
			new Set([freshDeletedEntry.file]),
		);
		expect(result.statusResult).toHaveLength(2);
	});

	it('pushes the full fresh status when the selection is empty', async () => {
		const result = await service.pushWorkfolder(user, { fileNames: [], commitMessage: 'x' });
		expect(result.statusResult).toEqual([freshWorkflowEntry, freshDeletedEntry]);
	});
});
