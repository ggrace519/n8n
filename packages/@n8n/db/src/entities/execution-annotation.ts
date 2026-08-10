import {
	Column,
	Entity,
	Generated,
	Index,
	JoinColumn,
	JoinTable,
	ManyToMany,
	OneToMany,
	OneToOne,
	PrimaryColumn,
} from '@n8n/typeorm';
import type { AnnotationVote } from 'n8n-workflow';

import { WithTimestamps } from './abstract-entity';
import type { AnnotationTagEntity } from './annotation-tag-entity';
import type { AnnotationTagMapping } from './annotation-tag-mapping';
import { ExecutionEntity } from './execution-entity';
import { idStringifier } from '../utils/transformers';

/**
 * A reviewer's verdict on one execution: an optional vote, an optional free-text
 * note, and any number of tags. At most one annotation exists per execution —
 * the unique index on `executionId` is what makes the upsert-by-execution in
 * `ExecutionService.annotate` safe.
 */
@Entity({ name: 'execution_annotations' })
export class ExecutionAnnotation extends WithTimestamps {
	// Int column exposed as a string, matching how `ExecutionEntity.id` is handled.
	@Generated()
	@PrimaryColumn({ transformer: idStringifier })
	id: string;

	@Column({ type: 'varchar', length: 6, nullable: true })
	vote: AnnotationVote | null;

	@Column({ type: 'text', nullable: true })
	note: string | null;

	@Column({ transformer: idStringifier })
	@Index({ unique: true })
	executionId: string;

	@OneToOne('ExecutionEntity', 'annotation', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'executionId' })
	execution: ExecutionEntity;

	@ManyToMany('AnnotationTagEntity', 'annotations')
	@JoinTable({
		name: 'execution_annotation_tags',
		joinColumn: { name: 'annotationId', referencedColumnName: 'id' },
		inverseJoinColumn: { name: 'tagId', referencedColumnName: 'id' },
	})
	tags: AnnotationTagEntity[];

	@OneToMany('AnnotationTagMapping', 'annotations')
	tagMappings: AnnotationTagMapping[];
}
