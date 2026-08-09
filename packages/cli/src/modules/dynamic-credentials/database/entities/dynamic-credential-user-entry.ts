import { CredentialsEntity, User, WithTimestamps } from '@n8n/db';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import { DynamicCredentialResolver } from './credential-resolver';

/**
 * Per-user credential data, written when a resolver maps the execution identity
 * to an n8n user (the system resolver). `data` is opaque encrypted text.
 */
@Entity()
export class DynamicCredentialUserEntry extends WithTimestamps {
	@PrimaryColumn({ length: 16 })
	credentialId: string;

	@Index()
	@PrimaryColumn({ type: 'uuid' })
	userId: string;

	@Index()
	@PrimaryColumn({ length: 16 })
	resolverId: string;

	@Column({ type: 'text' })
	data: string;

	@ManyToOne(() => CredentialsEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'credentialId' })
	credential: CredentialsEntity;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user: User;

	@ManyToOne(() => DynamicCredentialResolver, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'resolverId' })
	resolver: DynamicCredentialResolver;
}
