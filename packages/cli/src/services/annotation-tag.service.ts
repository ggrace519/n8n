import type { AnnotationTagEntity, ITagWithCountDb } from '@n8n/db';
import { AnnotationTagRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { validateEntity } from '@/generic-helpers';

type GetAllResult<T> = T extends { withUsageCount: true }
	? ITagWithCountDb[]
	: AnnotationTagEntity[];

/**
 * Annotation tags are a separate namespace from workflow tags: same shape on the
 * wire (the editor drives both through `createTagsApi`), different table, and
 * gated on `annotationTag:*` rather than `tag:*`. Kept as its own service rather
 * than a mode flag on `TagService` so neither surface can grant the other's scope.
 */
@Service()
export class AnnotationTagService {
	constructor(private readonly annotationTagRepository: AnnotationTagRepository) {}

	toEntity(attrs: { name: string; id?: string }) {
		return this.annotationTagRepository.create({ ...attrs, name: attrs.name.trim() });
	}

	async save(tag: AnnotationTagEntity) {
		await validateEntity(tag);

		return await this.annotationTagRepository.save(tag, { transaction: false });
	}

	async delete(id: string) {
		return await this.annotationTagRepository.delete(id);
	}

	async getAll<T extends { withUsageCount: boolean }>(options?: T): Promise<GetAllResult<T>> {
		if (options?.withUsageCount) {
			return (await this.annotationTagRepository.findAllWithUsageCount()) as GetAllResult<T>;
		}

		return (await this.annotationTagRepository.findAll()) as GetAllResult<T>;
	}

	async getById(id: string) {
		return await this.annotationTagRepository.findOneOrFail({ where: { id } });
	}
}
