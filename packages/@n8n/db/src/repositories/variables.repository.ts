import { Service } from '@n8n/di';
import { DataSource, In, IsNull, Not, Repository } from '@n8n/typeorm';

import { Variables } from '../entities';

@Service()
export class VariablesRepository extends Repository<Variables> {
	constructor(dataSource: DataSource) {
		super(Variables, dataSource.manager);
	}

	async deleteByIds(ids: string[]): Promise<void> {
		await this.delete({ id: In(ids) });
	}

	/**
	 * Whether a variable with this key already exists at the destination
	 * (global when `projectId` is null, else that project), excluding
	 * `excludeId` so updates don't collide with themselves.
	 */
	async keyInUse(key: string, projectId: string | null, excludeId?: string): Promise<boolean> {
		return await this.exists({
			where: {
				key,
				project: projectId === null ? IsNull() : { id: projectId },
				...(excludeId ? { id: Not(excludeId) } : {}),
			},
		});
	}
}
