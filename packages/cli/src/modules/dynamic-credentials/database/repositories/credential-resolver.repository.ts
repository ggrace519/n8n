import { BaseRepository, type OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { DynamicCredentialResolver } from '../entities/credential-resolver';

@Service()
export class DynamicCredentialResolverRepository extends BaseRepository<DynamicCredentialResolver> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialResolver, dataSource.manager);
	}

	/**
	 * Inserts the resolver only when its id is not taken yet, so module init can
	 * seed the system resolver on every boot (and on every process of a
	 * multi-main setup) without clobbering an operator's edits.
	 */
	async insertIfAbsent(
		resolver: Pick<DynamicCredentialResolver, 'id' | 'name' | 'type' | 'config'>,
		ctx: OperationContext,
	): Promise<void> {
		await this.managerFor(ctx)
			.createQueryBuilder()
			.insert()
			.into(DynamicCredentialResolver)
			.values(resolver)
			.orIgnore()
			.execute();
	}

	async findById(id: string, ctx: OperationContext): Promise<DynamicCredentialResolver | null> {
		return await this.managerFor(ctx).findOne(DynamicCredentialResolver, { where: { id } });
	}

	async findAll(ctx: OperationContext): Promise<DynamicCredentialResolver[]> {
		return await this.managerFor(ctx).find(DynamicCredentialResolver, { order: { name: 'ASC' } });
	}

	async deleteById(id: string, ctx: OperationContext): Promise<number> {
		const result = await this.managerFor(ctx).delete(DynamicCredentialResolver, { id });
		return result.affected ?? 0;
	}
}
