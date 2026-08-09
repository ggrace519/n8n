import { UserError } from 'n8n-workflow';

/** The LDAP server could not be reached or the admin bind failed. */
export class LdapConnectionError extends UserError {}

/** The LDAP server rejected the operation (bad credentials, bad filter, …). */
export class LdapRejectionError extends UserError {}
