import type { INodeProperties } from 'n8n-workflow';

import { UnimplementedSecretsProvider } from './unimplemented-provider';

export class OnePasswordProvider extends UnimplementedSecretsProvider {
	name = 'onePassword';

	displayName = '1Password';

	/** No settings shape survives for this provider type; none is invented here. */
	properties: INodeProperties[] = [];
}
