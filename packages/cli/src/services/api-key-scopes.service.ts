import type { User } from '@n8n/db';
import { ProjectRelationRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { ApiKeyScope } from '@n8n/permissions';
import { getApiKeyScopesForPrincipal, PROJECT_CHECKED_API_KEY_SCOPES } from '@n8n/permissions';

/**
 * Which public-API key scopes a user may hold. A member's authority lives on
 * their project roles rather than their global role, so both are consulted;
 * see `getApiKeyScopesForPrincipal` for which project-derived scopes qualify.
 */
@Service()
export class ApiKeyScopesService {
	constructor(private readonly projectRelationRepository: ProjectRelationRepository) {}

	async getGrantableScopes(user: User): Promise<ApiKeyScope[]> {
		const globalScopes = user.role.scopes.map((scope) => scope.slug);
		const globallyGrantable = getApiKeyScopesForPrincipal(globalScopes, []);

		// Project roles only widen the scopes of users entitled to API keys at all:
		// a chat-only user keeps a viewer relation on their personal project, but the
		// public API is not theirs to reach (keys or token exchange).
		if (!globalScopes.includes('apiKey:create')) return globallyGrantable;

		// Owners and admins already hold every project-checked scope globally.
		const held = new Set(globallyGrantable);
		if (PROJECT_CHECKED_API_KEY_SCOPES.every((scope) => held.has(scope))) {
			return globallyGrantable;
		}

		const relations = await this.projectRelationRepository.findAllByUser(user.id);
		const projectScopes = relations.flatMap((relation) =>
			relation.role.scopes.map((scope) => scope.slug),
		);

		return getApiKeyScopesForPrincipal(globalScopes, projectScopes);
	}

	async canGrant(user: User, scopes: ApiKeyScope[]): Promise<boolean> {
		const grantable = new Set(await this.getGrantableScopes(user));
		return scopes.every((scope) => grantable.has(scope));
	}
}
