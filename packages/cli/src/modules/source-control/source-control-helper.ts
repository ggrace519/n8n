import type { SourceControlledFile } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { Container } from '@n8n/di';

export function isSourceControlLicensed(): boolean {
	return Container.get(LicenseState).isSourceControlLicensed();
}

export interface SourceControlPullTrackingInformation {
	userId: string;
	workflowUpdates: number;
	workflowConflicts: number;
	credConflicts: number;
}

/**
 * Aggregate a pull's status result into the counters shared by the
 * `source-control-user-pulled-api` and pull-UI telemetry events.
 */
export function getTrackingInformationFromPullResult(
	userId: string,
	result: SourceControlledFile[],
): SourceControlPullTrackingInformation {
	return {
		userId,
		workflowUpdates: result.filter((file) => file.type === 'workflow').length,
		workflowConflicts: result.filter((file) => file.type === 'workflow' && file.conflict).length,
		credConflicts: result.filter((file) => file.type === 'credential' && file.conflict).length,
	};
}

/** Classify a repository URL for the `source-control-settings-updated` event. */
export function getRepoType(repositoryUrl: string): 'github' | 'gitlab' | 'other' {
	if (repositoryUrl.includes('github.com')) return 'github';
	if (repositoryUrl.includes('gitlab.com')) return 'gitlab';
	return 'other';
}
