/**
 * A secret value as stored by a vendor: JSON objects and arrays are exposed
 * parsed, so expressions can reach nested keys; anything else stays a string.
 */
export function parseSecretValue(raw: string): unknown {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === 'object') return parsed;
	} catch {}
	return raw;
}
