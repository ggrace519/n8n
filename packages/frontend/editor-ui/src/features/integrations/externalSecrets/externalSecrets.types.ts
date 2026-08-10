import type { SecretsProviderState } from '@n8n/api-types';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

/**
 * A single legacy external-secrets provider as summarised by the backend
 * `/external-secrets/providers` routes. Mirrors the cli `LegacyProviderSummary`:
 * one provider per type, configured through the legacy settings row. `data`
 * holds the stored (redacted) settings; `properties` is only present on the
 * single-provider detail route and drives the settings form.
 */
export interface ExternalSecretsProvider {
	name: string;
	displayName: string;
	icon: string;
	state: SecretsProviderState;
	connected: boolean;
	connectedAt: Date | string | null;
	data: IDataObject;
	properties?: INodeProperties[];
}
