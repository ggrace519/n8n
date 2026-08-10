import { testDb } from '@n8n/backend-test-utils';
import { AnnotationTagRepository, GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Container } from '@n8n/di';

import { createUserShell } from './shared/db/users';
import type { SuperAgentTest } from './shared/types';
import * as utils from './shared/utils/';

let authOwnerAgent: SuperAgentTest;
let authMemberAgent: SuperAgentTest;

const testServer = utils.setupTestServer({ endpointGroups: ['annotationTags'] });

beforeAll(async () => {
	const ownerShell = await createUserShell(GLOBAL_OWNER_ROLE);
	authOwnerAgent = testServer.authAgentFor(ownerShell);

	const memberShell = await createUserShell(GLOBAL_MEMBER_ROLE);
	authMemberAgent = testServer.authAgentFor(memberShell);
});

beforeEach(async () => {
	await testDb.truncate(['AnnotationTagEntity']);
});

const annotationTagRepository = () => Container.get(AnnotationTagRepository);

describe('POST /annotation-tags', () => {
	test('should create an annotation tag', async () => {
		const response = await authOwnerAgent.post('/annotation-tags').send({ name: 'reviewed' });

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toMatchObject({ name: 'reviewed' });

		const stored = await annotationTagRepository().findBy({ name: 'reviewed' });
		expect(stored).toHaveLength(1);
	});

	test('should not create a duplicate annotation tag', async () => {
		await annotationTagRepository().save(annotationTagRepository().create({ name: 'reviewed' }));

		const response = await authOwnerAgent.post('/annotation-tags').send({ name: 'reviewed' });

		expect(response.statusCode).not.toBe(200);
		expect(await annotationTagRepository().findBy({ name: 'reviewed' })).toHaveLength(1);
	});

	test('should reject a name longer than the column allows', async () => {
		const response = await authOwnerAgent.post('/annotation-tags').send({ name: 'a'.repeat(25) });

		expect(response.statusCode).not.toBe(200);
		expect(await annotationTagRepository().find()).toHaveLength(0);
	});

	test('should not share a namespace with workflow tags', async () => {
		await authOwnerAgent.post('/annotation-tags').send({ name: 'reviewed' }).expect(200);

		const response = await authOwnerAgent.get('/annotation-tags').expect(200);

		expect(response.body.data).toHaveLength(1);
		expect(response.body.data[0]).toMatchObject({ name: 'reviewed' });
	});
});

describe('GET /annotation-tags', () => {
	test('should return all annotation tags', async () => {
		await annotationTagRepository().save([
			annotationTagRepository().create({ name: 'first' }),
			annotationTagRepository().create({ name: 'second' }),
		]);

		const response = await authOwnerAgent.get('/annotation-tags').expect(200);

		expect(response.body.data).toHaveLength(2);
		expect(response.body.data.map((tag: { name: string }) => tag.name).sort()).toEqual([
			'first',
			'second',
		]);
	});

	test('should return a usage count when asked for one', async () => {
		await annotationTagRepository().save(annotationTagRepository().create({ name: 'unused' }));

		const response = await authOwnerAgent
			.get('/annotation-tags')
			.query({ withUsageCount: 'true' })
			.expect(200);

		expect(response.body.data).toEqual([
			expect.objectContaining({ name: 'unused', usageCount: 0 }),
		]);
	});
});

describe('PATCH /annotation-tags/:id', () => {
	test('should rename an annotation tag', async () => {
		const tag = await annotationTagRepository().save(
			annotationTagRepository().create({ name: 'before' }),
		);

		const response = await authOwnerAgent
			.patch(`/annotation-tags/${tag.id}`)
			.send({ name: 'after' })
			.expect(200);

		expect(response.body.data).toMatchObject({ id: tag.id, name: 'after' });
		expect(await annotationTagRepository().findBy({ name: 'before' })).toHaveLength(0);
	});
});

describe('DELETE /annotation-tags/:id', () => {
	test('should delete an annotation tag', async () => {
		const tag = await annotationTagRepository().save(
			annotationTagRepository().create({ name: 'doomed' }),
		);

		await authOwnerAgent.delete(`/annotation-tags/${tag.id}`).expect(200);

		expect(await annotationTagRepository().find()).toHaveLength(0);
	});
});

describe('annotationTag scopes', () => {
	test('should let a member list annotation tags', async () => {
		await annotationTagRepository().save(annotationTagRepository().create({ name: 'visible' }));

		const response = await authMemberAgent.get('/annotation-tags').expect(200);

		expect(response.body.data).toHaveLength(1);
	});
});
