import { Column, Entity, Index, ManyToMany, OneToMany } from '@n8n/typeorm';
import { IsString, Length } from 'class-validator';

import { WithTimestampsAndStringId } from './abstract-entity';
import type { AnnotationTagMapping } from './annotation-tag-mapping';
import type { ExecutionAnnotation } from './execution-annotation';

/**
 * A tag applicable to an execution annotation. Deliberately separate from
 * {@link TagEntity} (workflow tags): the two namespaces are managed by
 * different scopes and surfaced by different editor screens.
 */
@Entity({ name: 'annotation_tag_entity' })
export class AnnotationTagEntity extends WithTimestampsAndStringId {
	@Column({ length: 24 })
	@Index({ unique: true })
	@IsString({ message: 'Tag name must be of type string.' })
	@Length(1, 24, { message: 'Tag name must be $constraint1 to $constraint2 characters long.' })
	name: string;

	@ManyToMany('ExecutionAnnotation', 'tags')
	annotations: ExecutionAnnotation[];

	@OneToMany('AnnotationTagMapping', 'tags')
	annotationMappings: AnnotationTagMapping[];
}
