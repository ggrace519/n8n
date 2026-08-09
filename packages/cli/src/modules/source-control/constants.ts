/**
 * Layout of the source-control work folder and its supporting SSH material.
 *
 * The work folder lives at `${InstanceSettings.n8nFolder}/git/` and contains:
 *
 * ```
 * git/
 * ├── workflows/<workflow-id>.json
 * ├── credential_stubs/<credential-id>.json
 * ├── datatables/<data-table-id>.json
 * ├── variable_stubs.json
 * ├── folders.json
 * └── tags.json
 * ```
 */
export const SOURCE_CONTROL_GIT_FOLDER = 'git';

export const SOURCE_CONTROL_SSH_FOLDER = 'ssh';

export const SOURCE_CONTROL_SSH_KEY_NAME = 'key';

export const SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER = 'workflows';

export const SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER = 'credential_stubs';

export const SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER = 'datatables';

export const SOURCE_CONTROL_VARIABLES_EXPORT_FILE = 'variable_stubs.json';

export const SOURCE_CONTROL_FOLDERS_EXPORT_FILE = 'folders.json';

export const SOURCE_CONTROL_TAGS_EXPORT_FILE = 'tags.json';

export const SOURCE_CONTROL_DEFAULT_BRANCH = 'main';

export const SOURCE_CONTROL_ORIGIN = 'origin';

/**
 * Settings row holding the instance SSH key pair. The private key is encrypted
 * with the instance key; see the `MoveSshKeysToDatabase` migration for the
 * stored shape (`{ encryptedPrivateKey, publicKey }`).
 */
export const SOURCE_CONTROL_SSH_KEYS_DB_KEY = 'features.sourceControl.sshKeys';
