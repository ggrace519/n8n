/**
 * Ownership of a resource as serialized into the source-control work folder.
 * Structured owners carry enough information to recreate the owning project
 * on import (team id/name, or the personal owner's email).
 */
export type StructuredResourceOwner =
	| {
			type: 'personal';
			projectId?: string;
			projectName?: string;
			personalEmail: string;
	  }
	| {
			type: 'team';
			teamId: string;
			teamName: string;
	  };

/**
 * A remote owner may also be a bare email string — the legacy serialization
 * format, still accepted on import and mapped to the user's personal project.
 */
export type RemoteResourceOwner = string | StructuredResourceOwner;
