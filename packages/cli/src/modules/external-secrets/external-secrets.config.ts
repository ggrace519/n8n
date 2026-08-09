import { Config, Env } from '@n8n/config';

@Config
export class ExternalSecretsConfig {
	/** How often (seconds) to poll secrets providers for updated secrets. */
	@Env('N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL')
	updateInterval: number = 300;

	/** Whether to allow project-scoped external-secrets provider connections. */
	@Env('N8N_EXTERNAL_SECRETS_FOR_PROJECTS')
	externalSecretsForProjects: boolean = false;

	/**
	 * Whether several connections may exist per provider type. Both this and
	 * {@link externalSecretsForProjects} select the connection-entity storage
	 * model; with both off the instance stays on the single legacy settings row.
	 */
	@Env('N8N_EXTERNAL_SECRETS_MULTIPLE_CONNECTIONS')
	externalSecretsMultipleConnections: boolean = false;
}
