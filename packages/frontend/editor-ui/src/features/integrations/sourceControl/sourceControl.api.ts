import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import type { GitCommitInfo, SourceControlledFile } from '@n8n/api-types';
import type { IWorkflowDb } from '@/Interface';
import { SOURCE_CONTROL_API_ROOT } from './sourceControl.constants';
import type { SourceControlPreferences, SshKeyType } from './sourceControl.types';

export interface PushWorkfolderPayload {
	force?: boolean;
	commitMessage?: string;
	fileNames: SourceControlledFile[];
}

export interface PullWorkfolderPayload {
	force?: boolean;
	autoPublish?: 'none' | 'all' | 'published';
}

export interface SourceControlStatusOptions {
	direction: 'push' | 'pull';
	preferLocalVersion?: boolean;
	verbose?: boolean;
}

export interface PushWorkfolderResult {
	files: SourceControlledFile[];
	commit: GitCommitInfo | null;
}

export const getPreferences = async (
	context: IRestApiContext,
): Promise<SourceControlPreferences> => {
	return await makeRestApiRequest(context, 'GET', `${SOURCE_CONTROL_API_ROOT}/preferences`);
};

export const savePreferences = async (
	context: IRestApiContext,
	preferences: Partial<SourceControlPreferences>,
): Promise<SourceControlPreferences> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`${SOURCE_CONTROL_API_ROOT}/preferences`,
		preferences,
	);
};

export const updatePreferences = async (
	context: IRestApiContext,
	preferences: Partial<SourceControlPreferences>,
): Promise<SourceControlPreferences> => {
	return await makeRestApiRequest(
		context,
		'PATCH',
		`${SOURCE_CONTROL_API_ROOT}/preferences`,
		preferences,
	);
};

export const disconnect = async (
	context: IRestApiContext,
	keepKeyPair: boolean,
): Promise<SourceControlPreferences> => {
	return await makeRestApiRequest(context, 'POST', `${SOURCE_CONTROL_API_ROOT}/disconnect`, {
		keepKeyPair,
	});
};

export const getBranches = async (
	context: IRestApiContext,
): Promise<{ branches: string[]; currentBranch: string }> => {
	return await makeRestApiRequest(context, 'GET', `${SOURCE_CONTROL_API_ROOT}/get-branches`);
};

export const generateKeyPair = async (
	context: IRestApiContext,
	keyGeneratorType?: SshKeyType,
): Promise<{ publicKey: string; keyGeneratorType: SshKeyType }> => {
	return await makeRestApiRequest(context, 'POST', `${SOURCE_CONTROL_API_ROOT}/generate-key-pair`, {
		...(keyGeneratorType ? { keyGeneratorType } : {}),
	});
};

export const pushWorkfolder = async (
	context: IRestApiContext,
	payload: PushWorkfolderPayload,
): Promise<PushWorkfolderResult> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`${SOURCE_CONTROL_API_ROOT}/push-workfolder`,
		payload,
	);
};

export const pullWorkfolder = async (
	context: IRestApiContext,
	payload: PullWorkfolderPayload,
): Promise<SourceControlledFile[]> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`${SOURCE_CONTROL_API_ROOT}/pull-workfolder`,
		payload,
	);
};

export const getAggregatedStatus = async (
	context: IRestApiContext,
	options: SourceControlStatusOptions,
): Promise<SourceControlledFile[]> => {
	return await makeRestApiRequest(context, 'GET', `${SOURCE_CONTROL_API_ROOT}/get-status`, {
		direction: options.direction,
		preferLocalVersion: options.preferLocalVersion ?? true,
		verbose: options.verbose ?? false,
	});
};

export const getStatus = async (context: IRestApiContext): Promise<SourceControlledFile[]> => {
	return await makeRestApiRequest(context, 'GET', `${SOURCE_CONTROL_API_ROOT}/status`);
};

export const getRemoteWorkflow = async (
	context: IRestApiContext,
	id: string,
): Promise<{ content: IWorkflowDb; type: string }> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`${SOURCE_CONTROL_API_ROOT}/remote-content/workflow/${encodeURIComponent(id)}`,
	);
};
