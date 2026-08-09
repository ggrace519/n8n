import { RoleMappingRuleRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import type { RoleDeletionChecker } from '@/services/role-deletion-check-proxy.service';

import { ProvisioningService } from './provisioning.service';

/**
 * Blocks deleting a role that SSO provisioning still points at — as a mapping
 * rule's target or as the default condition — so a login cannot resolve to a
 * role that no longer exists.
 */
@Service()
export class ProvisioningRoleDeletionChecker implements RoleDeletionChecker {
	constructor(
		private readonly roleMappingRuleRepository: RoleMappingRuleRepository,
		private readonly provisioningService: ProvisioningService,
	) {}

	async findRoleDeletionBlockers(roleSlug: string): Promise<string[]> {
		const blockers: string[] = [];

		const ruleCount = await this.roleMappingRuleRepository.countByRoleSlug(roleSlug);
		if (ruleCount > 0) {
			blockers.push(`referenced by ${ruleCount} role mapping rule${ruleCount === 1 ? '' : 's'}`);
		}

		const config = await this.provisioningService.getProvisioningConfig();
		if (config.defaultInstanceRole === roleSlug) {
			blockers.push('used as the SSO provisioning default instance role');
		}

		return blockers;
	}
}
