/**
 * A single environment variable as exposed to the editor UI.
 *
 * `project` is `null`/absent for global (instance-wide) variables and carries
 * the owning project for project-scoped ones. `value` is always a string —
 * the backend currently only supports the `string` type.
 */
export interface EnvironmentVariable {
	id: string;
	key: string;
	value: string;
	type?: string;
	project?: { id: string; name: string } | null;
}

/** Request body for creating a variable. `id` is assigned by the backend. */
export interface CreateEnvironmentVariablePayload {
	key: string;
	value: string;
	type?: string;
	projectId?: string;
}

/** Request body for updating an existing variable. */
export interface UpdateEnvironmentVariablePayload {
	id: string;
	key?: string;
	value?: string;
	type?: string;
	projectId?: string | null;
}

/** Scope options offered when creating/editing a variable (`global` or a project id). */
export type VariableScope = 'global' | string;
