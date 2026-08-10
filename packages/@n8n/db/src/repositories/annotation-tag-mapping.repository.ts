import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AnnotationTagMapping } from '../entities';

@Service()
export class AnnotationTagMappingRepository extends Repository<AnnotationTagMapping> {
	constructor(dataSource: DataSource) {
		super(AnnotationTagMapping, dataSource.manager);
	}

	/**
	 * Replace an annotation's tags wholesale. PATCH sends the complete desired
	 * set, so anything not in `tagIds` is removed.
	 */
	async overwriteTags(annotationId: string, tagIds: string[]) {
		return await this.manager.transaction(async (tx) => {
			await tx.delete(AnnotationTagMapping, { annotationId });

			if (tagIds.length === 0) return;

			const mappings = tagIds.map((tagId) => this.create({ annotationId, tagId }));

			await tx.insert(AnnotationTagMapping, mappings);
		});
	}
}
