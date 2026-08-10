/** Modal key for the create/edit variable dialog, registered in the UI store. */
export const VARIABLE_MODAL_KEY = 'variable';

/** REST root for the variables API (see cli `VariablesController`). */
export const VARIABLES_API_ROOT = 'variables';

/** Max length of a variable key, mirrors the backend `VARIABLE_KEY_MAX_LENGTH`. */
export const VARIABLE_KEY_MAX_LENGTH = 50;

/** Max length of a variable value, mirrors the backend `VALUE_MAX_LENGTH`. */
export const VARIABLE_VALUE_MAX_LENGTH = 1000;

/**
 * Allowed characters for a variable key on create. Kept in sync with the
 * backend `NEW_VARIABLE_KEY_REGEX`: must start with a letter or underscore so
 * dot-notation access (`$vars.MY_VAR`) stays valid.
 */
export const NEW_VARIABLE_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Prefix used to reference variables inside expressions. */
export const VARIABLE_EXPRESSION_PREFIX = '$vars';
