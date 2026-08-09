import type { RemoteResourceOwner } from './resource-owner';

/**
 * A credential as serialized to `credential_stubs/<id>.json`. Secrets are
 * stripped before export: decrypted string values are replaced with `''`,
 * `oauthTokenData` is omitted entirely, and only the object structure plus
 * non-string primitives survive.
 */
export interface ExportableCredential {
	id: string;
	name: string;
	type: string;
	data: Record<string, unknown>;
	ownedBy: RemoteResourceOwner | null;
	isGlobal: boolean;
	isResolvable?: boolean;
	resolvableAllowFallback?: boolean;
}
