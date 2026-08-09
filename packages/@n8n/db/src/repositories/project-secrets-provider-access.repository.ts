import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { ProjectSecretsProviderAccess } from '../entities';
import type { SecretsProviderAccessRole } from '../entities';
import type { OperationContext } from '../services/transaction';

@Service()
export class ProjectSecretsProviderAccessRepository extends BaseRepository<ProjectSecretsProviderAccess> {
	constructor(dataSource: DataSource) {
		super(ProjectSecretsProviderAccess, dataSource.manager);
	}

	/** All grants held by a project, in whatever order the driver returns them. */
	async findByProjectId(
		projectId: string,
		ctx: OperationContext = {},
	): Promise<ProjectSecretsProviderAccess[]> {
		return await this.managerFor(ctx).find(this.target, { where: { projectId } });
	}

	/** Drop every grant a project holds. Used when the project itself goes away. */
	async deleteByProjectId(projectId: string, ctx: OperationContext = {}): Promise<void> {
		await this.managerFor(ctx).delete(this.target, { projectId });
	}

	/** Replace a connection's grants: drop all of them, callers re-create what remains. */
	async deleteByConnectionId(
		secretsProviderConnectionId: number,
		ctx: OperationContext = {},
	): Promise<void> {
		await this.managerFor(ctx).delete(this.target, { secretsProviderConnectionId });
	}

	/** Grant a set of projects access to one connection. */
	async createGrants(
		secretsProviderConnectionId: number,
		projectIds: string[],
		role: SecretsProviderAccessRole,
		ctx: OperationContext = {},
	): Promise<void> {
		if (projectIds.length === 0) return;
		const manager = this.managerFor(ctx);
		await manager.save(
			projectIds.map((projectId) =>
				manager.create(this.target, { secretsProviderConnectionId, projectId, role }),
			),
		);
	}

	/** Grants for the given connections, used to shape connection responses. */
	async findByConnectionIds(
		secretsProviderConnectionIds: number[],
		ctx: OperationContext = {},
	): Promise<ProjectSecretsProviderAccess[]> {
		if (secretsProviderConnectionIds.length === 0) return [];
		return await this.managerFor(ctx).find(this.target, {
			where: { secretsProviderConnectionId: In(secretsProviderConnectionIds) },
		});
	}
}
