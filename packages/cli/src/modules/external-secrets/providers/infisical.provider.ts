import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class InfisicalProvider extends UnimplementedSecretsProvider {
	name = 'infisical';

	displayName = 'Infisical';

	/** No settings shape survives for this provider type; none is invented here. */
	properties: INodeProperties[] = [];
}
