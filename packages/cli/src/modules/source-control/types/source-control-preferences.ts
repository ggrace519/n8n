/**
 * Instance-wide source-control (git) preferences. Persisted as a single
 * settings row; `publicKey` is derived at runtime and never persisted here.
 */
export interface SourceControlPreferences {
	connected: boolean;
	repositoryUrl: string;
	branchName: string;
	branchReadOnly: boolean;
	branchColor: string;
	publicKey?: string;
	keyGeneratorType?: 'ed25519' | 'rsa';
	initRepo?: boolean;
}

export const DEFAULT_SOURCE_CONTROL_PREFERENCES: SourceControlPreferences = {
	connected: false,
	repositoryUrl: '',
	branchName: '',
	branchReadOnly: false,
	branchColor: '#5296D6',
};
