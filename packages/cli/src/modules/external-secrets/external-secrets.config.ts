import { Config, Env } from '@n8n/config';

@Config
export class ExternalSecretsConfig {
	/** How often (seconds) to poll secrets providers for updated secrets. */
	@Env('N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL')
	updateInterval: number = 300;

	/** Whether to allow project-scoped external-secrets provider connections. */
	@Env('N8N_EXTERNAL_SECRETS_FOR_PROJECTS')
	externalSecretsForProjects: boolean = false;
}
