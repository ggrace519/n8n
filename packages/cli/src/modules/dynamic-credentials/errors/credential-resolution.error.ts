import { UserError } from 'n8n-workflow';

/**
 * Raised when a node needs an end-user credential but no per-identity data
 * could be resolved for the running execution — a user-actionable condition
 * (connect the credential, or run with an identity), not a bug.
 */
export class CredentialResolutionError extends UserError {}
