import { Config, Env } from '@n8n/config';

@Config
export class DynamicCredentialsConfig {
	/**
	 * Static token an external caller presents to the dynamic-credential
	 * endpoints. Empty means no token has been provisioned.
	 */
	@Env('N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN')
	endpointAuthToken: string = '';

	/** Origin allowed to call those endpoints from a browser. */
	@Env('N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN')
	corsOrigin: string = '';

	/** Whether those endpoints answer with `Access-Control-Allow-Credentials`. */
	@Env('N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS')
	corsAllowCredentials: boolean = false;
}
