import isEqual from 'lodash/isEqual';
import type { ICredentialDataDecryptedObject, ICredentialType } from 'n8n-workflow';

/**
 * Names of the shared credential fields — static fields, not per-identity
 * `resolvableField`s — whose value differs between the stored and the new
 * credential data. `newData` must be un-redacted.
 */
export function getChangedSharedFields(
	credentialType: ICredentialType,
	oldData: ICredentialDataDecryptedObject,
	newData: ICredentialDataDecryptedObject,
): string[] {
	return credentialType.properties
		.filter((property) => !property.resolvableField)
		.map((property) => property.name)
		.filter((name) => !isEqual(oldData[name], newData[name]));
}
