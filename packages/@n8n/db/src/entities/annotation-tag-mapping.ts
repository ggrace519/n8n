import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import type { AnnotationTagEntity } from './annotation-tag-entity';
import type { ExecutionAnnotation } from './execution-annotation';
import { idStringifier } from '../utils/transformers';

/**
 * Join table behind {@link ExecutionAnnotation.tags}. Mapped explicitly so tag
 * assignments can be replaced and counted without loading the annotations.
 */
@Entity({ name: 'execution_annotation_tags' })
export class AnnotationTagMapping {
	@PrimaryColumn({ transformer: idStringifier })
	annotationId: string;

	@ManyToOne('ExecutionAnnotation', 'tagMappings')
	@JoinColumn({ name: 'annotationId' })
	annotations: ExecutionAnnotation[];

	@PrimaryColumn()
	tagId: string;

	@ManyToOne('AnnotationTagEntity', 'annotationMappings')
	@JoinColumn({ name: 'tagId' })
	tags: AnnotationTagEntity[];
}
