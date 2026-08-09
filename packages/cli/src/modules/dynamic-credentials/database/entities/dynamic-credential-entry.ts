import { CredentialsEntity, WithTimestamps } from '@n8n/db';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import { DynamicCredentialResolver } from './credential-resolver';

/**
 * Per-subject credential data for a resolver that maps an execution identity to
 * an arbitrary external subject (not an n8n user). `data` is opaque encrypted
 * text — this layer never interprets it.
 *
 * Column names are snake_case here (the table predates the camelCase
 * convention used by `dynamic_credential_user_entry`).
 */
@Entity()
export class DynamicCredentialEntry extends WithTimestamps {
	@PrimaryColumn({ name: 'credential_id', length: 16 })
	credentialId: string;

	@Index()
	@PrimaryColumn({ name: 'subject_id', length: 2048 })
	subjectId: string;

	@Index()
	@PrimaryColumn({ name: 'resolver_id', length: 16 })
	resolverId: string;

	@Column({ type: 'text' })
	data: string;

	@ManyToOne(() => CredentialsEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'credential_id' })
	credential: CredentialsEntity;

	@ManyToOne(() => DynamicCredentialResolver, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'resolver_id' })
	resolver: DynamicCredentialResolver;
}
