import type {
	CreateCredentialResolverDto,
	CredentialResolverType,
	UpdateCredentialResolverDto,
} from '@n8n/api-types';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { CredentialResolverWorkflowService } from './credential-resolver-workflow.service';
import { SYSTEM_RESOLVER_ID } from '../constants';
import { DynamicCredentialEntryStorage } from '../credential-resolvers/storage/dynamic-credential-entry-storage';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import type { DynamicCredentialResolver } from '../database/entities/credential-resolver';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';

/**
 * The API schemas allow longer names/types than the tables do (255 vs 128), so
 * the stricter database limits are enforced here — a rejected request beats a
 * driver-level truncation error.
 */
const MAX_NAME_LENGTH = 128;
const MAX_TYPE_LENGTH = 128;

export type CredentialResolverResponse = {
	id: string;
	name: string;
	type: string;
	config: string;
	decryptedConfig?: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
};

@Service()
export class CredentialResolverCrudService {
	constructor(
		private readonly cipher: Cipher,
		private readonly resolverRepository: DynamicCredentialResolverRepository,
		private readonly workflowService: CredentialResolverWorkflowService,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
		private readonly entryStorage: DynamicCredentialEntryStorage,
	) {}

	/**
	 * Resolver types are contributed by resolver implementations. Only the
	 * built-in n8n self-connect resolver ships today.
	 */
	listTypes(): CredentialResolverType[] {
		return [
			{
				name: 'n8n',
				displayName: 'n8n',
				description: 'Each user connects their own account through n8n.',
			},
		];
	}

	async list(includeSystem: boolean): Promise<CredentialResolverResponse[]> {
		const resolvers = await this.resolverRepository.findAll({});
		return resolvers
			.filter((resolver) => includeSystem || resolver.id !== SYSTEM_RESOLVER_ID)
			.map((resolver) => this.toResponse(resolver));
	}

	async get(id: string): Promise<CredentialResolverResponse> {
		const resolver = await this.findOrFail(id);
		return {
			...this.toResponse(resolver),
			decryptedConfig: await this.decryptConfig(resolver.config),
		};
	}

	async create(payload: CreateCredentialResolverDto): Promise<CredentialResolverResponse> {
		this.assertFitsDatabase(payload.name, payload.type);

		const resolver = this.resolverRepository.create({
			name: payload.name,
			type: payload.type,
			config: await this.cipher.encryptV2(payload.config),
		});

		return this.toResponse(await this.resolverRepository.save(resolver));
	}

	async update(
		id: string,
		payload: UpdateCredentialResolverDto,
	): Promise<CredentialResolverResponse> {
		const resolver = await this.findOrFail(id);
		this.assertNotSystemResolver(id, 'updated');
		this.assertFitsDatabase(payload.name, payload.type);

		if (payload.name !== undefined) resolver.name = payload.name;
		if (payload.type !== undefined) resolver.type = payload.type;
		if (payload.config !== undefined) resolver.config = await this.cipher.encryptV2(payload.config);

		const saved = await this.resolverRepository.save(resolver);

		// A configuration change invalidates what was minted against the old one.
		if (payload.clearCredentials === true) await this.clearStoredCredentials(saved);

		return this.toResponse(saved);
	}

	async delete(id: string): Promise<void> {
		const resolver = await this.findOrFail(id);
		this.assertNotSystemResolver(id, 'deleted');

		const activeWorkflowIds = await this.workflowService.findActiveWorkflowIds(id);
		if (activeWorkflowIds.length > 0) {
			throw new BadRequestError(
				'This resolver is still used by published workflows. Unpublish them first.',
			);
		}

		// Entry rows cascade from the database; workflow settings naming this
		// resolver do not. Clear them first — a half-done delete then leaves
		// workflows on the default resolver rather than pointing at a dead id.
		await this.workflowService.clearResolverFromWorkflows(resolver.id);
		await this.resolverRepository.deleteById(resolver.id, {});
	}

	async findAffectedWorkflows(id: string) {
		await this.findOrFail(id);
		return await this.workflowService.findAffectedWorkflows(id);
	}

	private async clearStoredCredentials(resolver: DynamicCredentialResolver): Promise<void> {
		const input = {
			resolverId: resolver.id,
			resolverName: resolver.name,
			configuration: (await this.decryptConfig(resolver.config)) ?? {},
		};
		await this.userEntryStorage.deleteAllCredentialData(input);
		await this.entryStorage.deleteAllCredentialData(input);
	}

	private async findOrFail(id: string): Promise<DynamicCredentialResolver> {
		const resolver = await this.resolverRepository.findById(id, {});
		if (!resolver) throw new NotFoundError(`Could not find credential resolver with ID "${id}".`);
		return resolver;
	}

	private assertNotSystemResolver(id: string, action: string): void {
		if (id === SYSTEM_RESOLVER_ID) {
			throw new BadRequestError(`The built-in n8n credential resolver cannot be ${action}.`);
		}
	}

	private assertFitsDatabase(name?: string, type?: string): void {
		if (name !== undefined && name.length > MAX_NAME_LENGTH) {
			throw new BadRequestError(`Resolver name must be at most ${MAX_NAME_LENGTH} characters.`);
		}
		if (type !== undefined && type.length > MAX_TYPE_LENGTH) {
			throw new BadRequestError(`Resolver type must be at most ${MAX_TYPE_LENGTH} characters.`);
		}
	}

	/** Never fails the request over an unreadable config — just omits it. */
	private async decryptConfig(config: string): Promise<Record<string, unknown> | undefined> {
		try {
			return jsonParse<Record<string, unknown>>(await this.cipher.decryptV2(config));
		} catch {
			return undefined;
		}
	}

	private toResponse(resolver: DynamicCredentialResolver): CredentialResolverResponse {
		return {
			id: resolver.id,
			name: resolver.name,
			type: resolver.type,
			config: resolver.config,
			createdAt: resolver.createdAt,
			updatedAt: resolver.updatedAt,
		};
	}
}
