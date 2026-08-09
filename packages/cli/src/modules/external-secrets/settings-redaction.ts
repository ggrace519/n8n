import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

/** Names of the settings fields a provider declares as passwords. */
function passwordFieldNames(properties: INodeProperties[]): Set<string> {
	return new Set(
		properties.filter((property) => property.typeOptions?.password === true).map((p) => p.name),
	);
}

/**
 * A copy of `settings` safe to put in an API response: every password-typed
 * field that holds a value is replaced by the blanking marker. Non-password
 * fields (region, URL, namespace, …) are returned verbatim — they are
 * configuration, not credentials.
 */
export function redactSettings(settings: IDataObject, properties: INodeProperties[]): IDataObject {
	const passwords = passwordFieldNames(properties);
	const redacted: IDataObject = {};

	for (const [name, value] of Object.entries(settings)) {
		redacted[name] =
			passwords.has(name) && value !== undefined && value !== null && value !== ''
				? CREDENTIAL_BLANKING_VALUE
				: value;
	}

	return redacted;
}

/**
 * The inverse of {@link redactSettings} for incoming payloads: a password field
 * still carrying the blanking marker means "unchanged", so the stored value is
 * kept rather than overwritten with the marker itself.
 */
export function restoreRedactedSettings(
	incoming: IDataObject,
	stored: IDataObject,
	properties: INodeProperties[],
): IDataObject {
	const passwords = passwordFieldNames(properties);
	const restored: IDataObject = { ...incoming };

	for (const name of Object.keys(incoming)) {
		if (passwords.has(name) && incoming[name] === CREDENTIAL_BLANKING_VALUE) {
			if (name in stored) restored[name] = stored[name];
			else delete restored[name];
		}
	}

	return restored;
}
