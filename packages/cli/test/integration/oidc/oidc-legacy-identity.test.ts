import { testDb } from '@n8n/backend-test-utils';
import { AuthIdentity, AuthIdentityRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import { createMember } from '../shared/db/users';

/**
 * `OidcService` re-keys subject-only identity rows to the issuer-scoped
 * `providerId` in place. Both columns form the primary key, so the write is
 * exercised against a real database here rather than a repository mock.
 */
describe('OIDC identity re-keying', () => {
	let authIdentityRepository: AuthIdentityRepository;

	beforeAll(async () => {
		await testDb.init();
		authIdentityRepository = Container.get(AuthIdentityRepository);
	});

	afterEach(async () => {
		await testDb.truncate(['AuthIdentity', 'User']);
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	it('moves a subject-only row to its issuer-scoped identifier', async () => {
		const user = await createMember();
		await authIdentityRepository.save(AuthIdentity.create(user, 'subject-1', 'oidc'));

		await authIdentityRepository.update(
			{ providerId: 'subject-1', providerType: 'oidc' },
			{ providerId: 'oidc:v1:digest-value' },
		);

		expect(
			await authIdentityRepository.findOne({
				where: { providerId: 'subject-1', providerType: 'oidc' },
			}),
		).toBeNull();

		const rekeyed = await authIdentityRepository.findOne({
			where: { providerId: 'oidc:v1:digest-value', providerType: 'oidc' },
		});
		expect(rekeyed?.userId).toBe(user.id);
		expect(await authIdentityRepository.count({ where: { userId: user.id } })).toBe(1);
	});
});
