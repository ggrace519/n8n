import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, Index } from '@n8n/typeorm';

/**
 * A configured strategy for turning an execution identity into a credential
 * subject and a per-subject credential payload. `config` holds the resolver's
 * settings encrypted as a single string — never plaintext.
 */
@Entity()
export class DynamicCredentialResolver extends WithTimestampsAndStringId {
	@Column({ length: 128 })
	name: string;

	@Index()
	@Column({ length: 128 })
	type: string;

	@Column({ type: 'text' })
	config: string;
}
