import { Container } from '@n8n/di';
import type { EntityManager } from '@n8n/typeorm';
import { mock } from 'vitest-mock-extended';

import { AnnotationTagMapping } from '../../entities';
import { mockEntityManager } from '../../utils/test-utils/mock-entity-manager';
import { AnnotationTagMappingRepository } from '../annotation-tag-mapping.repository';

describe('AnnotationTagMappingRepository', () => {
	const entityManager = mockEntityManager(AnnotationTagMapping);
	const repository = Container.get(AnnotationTagMappingRepository);

	beforeEach(() => {
		// `create` is a passthrough here; the mocked manager would return undefined.
		vi.spyOn(repository, 'create').mockImplementation(
			(attrs: unknown) => attrs as AnnotationTagMapping,
		);
	});

	const runInTransaction = () => {
		const transactionManager = mock<EntityManager>();
		entityManager.transaction.mockImplementation(
			async (unitOfWork: unknown) =>
				await (unitOfWork as (tx: EntityManager) => Promise<unknown>)(transactionManager),
		);
		return transactionManager;
	};

	it('replaces the previous tags rather than adding to them', async () => {
		const tx = runInTransaction();

		await repository.overwriteTags('7', ['tag-a', 'tag-b']);

		expect(tx.delete).toHaveBeenCalledWith(AnnotationTagMapping, { annotationId: '7' });
		expect(tx.insert).toHaveBeenCalledWith(AnnotationTagMapping, [
			expect.objectContaining({ annotationId: '7', tagId: 'tag-a' }),
			expect.objectContaining({ annotationId: '7', tagId: 'tag-b' }),
		]);
	});

	it('clears the tags without inserting an empty row set', async () => {
		const tx = runInTransaction();

		await repository.overwriteTags('7', []);

		expect(tx.delete).toHaveBeenCalledWith(AnnotationTagMapping, { annotationId: '7' });
		expect(tx.insert).not.toHaveBeenCalled();
	});
});
