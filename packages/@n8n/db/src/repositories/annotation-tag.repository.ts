import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

import { AnnotationTagEntity } from '../entities';
import type { ITagWithCountDb } from '../entities/types-db';

@Service()
export class AnnotationTagRepository extends Repository<AnnotationTagEntity> {
	constructor(dataSource: DataSource) {
		super(AnnotationTagEntity, dataSource.manager);
	}

	async findMany(tagIds: string[]) {
		return await this.find({
			select: ['id', 'name'],
			where: { id: In(tagIds) },
		});
	}

	/** All annotation tags, newest name-ordering left to the caller. */
	async findAll() {
		return await this.find({ select: ['id', 'name', 'createdAt', 'updatedAt'] });
	}

	/**
	 * All annotation tags, each carrying how many execution annotations use it.
	 * Backs `GET /annotation-tags?withUsageCount=true`.
	 */
	async findAllWithUsageCount(): Promise<ITagWithCountDb[]> {
		const tags = await this.createQueryBuilder('annotationTag')
			.select([
				'annotationTag.id',
				'annotationTag.name',
				'annotationTag.createdAt',
				'annotationTag.updatedAt',
			])
			.loadRelationCountAndMap('annotationTag.usageCount', 'annotationTag.annotationMappings')
			.getMany();

		return tags as unknown as ITagWithCountDb[];
	}
}
