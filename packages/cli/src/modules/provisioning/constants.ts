/** Settings-table key holding the persisted `ProvisioningConfigDto` row. */
export const PROVISIONING_PREFERENCES_DB_KEY = 'sso.provisioning.config';

/** Rule types; ordering and "first match wins" are scoped to one type. */
export const INSTANCE_RULE_TYPE = 'instance';
export const PROJECT_RULE_TYPE = 'project';

/**
 * Sandbox budget for a mapping-rule expression. Deliberately far below the
 * workflow-expression defaults (5s / 128MB): a rule is a small boolean
 * predicate, and every login waits on it.
 */
export const RULE_EXPRESSION_TIMEOUT_MS = 500;
export const RULE_EXPRESSION_MEMORY_LIMIT_MB = 16;

/**
 * Ceilings applied to IdP claims before they are copied into the isolate.
 * Claims are attacker-influenced input, so an oversized or deeply nested
 * document is rejected on the host side rather than inside the sandbox.
 */
export const MAX_CLAIMS_SERIALIZED_BYTES = 128 * 1024;
export const MAX_CLAIMS_DEPTH = 16;
