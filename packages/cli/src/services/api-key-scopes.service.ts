import type { User } from '@n8n/db';
import { ProjectRelationRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { ApiKeyScope } from '@n8n/permissions';
import { getApiKeyScopesForPrincipal } from '@n8n/permissions';

/**
 * Which public-API key scopes a user may hold. A member's authority lives on
 * their project roles rather than their global role, so both are consulted;
 * see `getApiKeyScopesForPrincipal` for which project-derived scopes qualify.
 */
@Service()
export class ApiKeyScopesService {
	constructor(private readonly projectRelationRepository: ProjectRelationRepository) {}

	async getGrantableScopes(user: User): Promise<ApiKeyScope[]> {
		const relations = await this.projectRelationRepository.findAllByUser(user.id);
		const projectScopes = relations.flatMap((relation) =>
			relation.role.scopes.map((scope) => scope.slug),
		);

		return getApiKeyScopesForPrincipal(
			user.role.scopes.map((scope) => scope.slug),
			projectScopes,
		);
	}

	async canGrant(user: User, scopes: ApiKeyScope[]): Promise<boolean> {
		const grantable = new Set(await this.getGrantableScopes(user));
		return scopes.every((scope) => grantable.has(scope));
	}
}
