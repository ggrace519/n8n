import { testDb } from '@n8n/backend-test-utils';
import { ApiKeyRepository, UserRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { createAdminWithApiKey, createOwnerWithApiKey } from '@test-integration/db/users';

import { ApiKeyScopesService } from '../api-key-scopes.service';
import { JwtService } from '../jwt.service';
import { PublicApiKeyService } from '../public-api-key.service';

const instanceSettings = mock<InstanceSettings>({ encryptionKey: 'test-key' });

const jwtService = new JwtService(instanceSettings, mock());

let apiKeyRepository: ApiKeyRepository;
let publicApiKeyService: PublicApiKeyService;

describe('PublicApiKeyService', () => {
	beforeEach(async () => {
		await testDb.truncate(['User']);
		vi.clearAllMocks();
	});

	beforeAll(async () => {
		await testDb.init();
		apiKeyRepository = Container.get(ApiKeyRepository);
		publicApiKeyService = new PublicApiKeyService(
			apiKeyRepository,
			jwtService,
			mock(),
			mock(),
			Container.get(ApiKeyScopesService),
		);
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	describe('redactApiKey', () => {
		it('should redact api key', async () => {
			//Arrange

			const jwt =
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE0ODUxNDA5ODQsImlhdCI6MTQ4NTEzNzM4NCwiaXNzIjoiYWNtZS5jb20iLCJzdWIiOiIyOWFjMGMxOC0wYjRhLTQyY2YtODJmYy0wM2Q1NzAzMThhMWQiLCJhcHBsaWNhdGlvbklkIjoiNzkxMDM3MzQtOTdhYi00ZDFhLWFmMzctZTAwNmQwNWQyOTUyIiwicm9sZXMiOltdfQ.Mp0Pcwsz5VECK11Kf2ZZNF_SMKu5CgBeLN9ZOP04kZo';

			//Act

			const redactedApiKey = publicApiKeyService.redactApiKey(jwt);

			//Assert

			expect(redactedApiKey).toBe('******4kZo');
		});
	});

	describe('pruneScopesToGrantable', () => {
		it("drops the key scopes a demoted user's new role no longer backs", async () => {
			const admin = await createAdminWithApiKey();
			const apiKeyId = admin.apiKeys[0].id;
			const userRepository = Container.get(UserRepository);
			await userRepository.update(admin.id, { role: { slug: 'global:member' } });
			const demoted = await userRepository.findOneOrFail({
				where: { id: admin.id },
				relations: { role: true },
			});

			await publicApiKeyService.pruneScopesToGrantable(demoted);

			const { scopes } = await apiKeyRepository.findOneByOrFail({ id: apiKeyId });
			expect(scopes).not.toContain('user:create');
			expect(scopes).not.toContain('project:create');
			expect(scopes).toEqual(expect.arrayContaining(['workflow:read', 'tag:read']));
		});

		it('leaves keys untouched when every scope is still grantable', async () => {
			const owner = await createOwnerWithApiKey();
			const { id, scopes: before } = owner.apiKeys[0];

			await publicApiKeyService.pruneScopesToGrantable(owner);

			const { scopes: after } = await apiKeyRepository.findOneByOrFail({ id });
			expect(after.sort()).toEqual([...before].sort());
		});
	});
});
