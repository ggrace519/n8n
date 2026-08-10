import type { SourceControlledFile } from '@n8n/api-types';

/**
 * Instance-wide source-control (git) preferences as surfaced to the frontend.
 * Mirrors the backend `SourceControlPreferences` shape returned by
 * `GET /rest/source-control/preferences`. Fields are optional on the wire
 * because the backend redacts connection details for non-manager users.
 */
export interface SourceControlPreferences {
	connected: boolean;
	repositoryUrl: string;
	branchName: string;
	branches?: string[];
	branchReadOnly: boolean;
	branchColor: string;
	publicKey?: string;
	keyGeneratorType?: SshKeyType;
	initRepo?: boolean;
}

export type SshKeyType = 'ed25519' | 'rsa';

/**
 * A single changed resource reported by the source-control status endpoints,
 * aggregated across push/pull directions. Re-exported from the shared schema so
 * consumers can import it from the feature module.
 */
export type SourceControlAggregatedFile = SourceControlledFile;

export type { SourceControlledFile };
