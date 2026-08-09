import type { SshKeyType } from './sourceControl.types';

export const SOURCE_CONTROL_PUSH_MODAL_KEY = 'sourceControlPush';
export const SOURCE_CONTROL_PULL_MODAL_KEY = 'sourceControlPull';
export const SOURCE_CONTROL_PULL_RESULT_MODAL_KEY = 'sourceControlPullResult';

/** Base path of the source-control REST endpoints (mounted under `/rest`). */
export const SOURCE_CONTROL_API_ROOT = '/source-control';

/** Default git branch color used when the instance has not picked one. */
export const SOURCE_CONTROL_DEFAULT_BRANCH_COLOR = '#5296D6';

/** SSH key types offered when (re)generating the instance key pair. */
export const SSH_KEY_TYPES: SshKeyType[] = ['ed25519', 'rsa'];
