import { LockNamespace, LockService } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';
import { InstanceSettings } from 'n8n-core';

import { SourceControlService } from '../source-control.service';

/** Exposes the private lock wrapper so the tests can drive it directly. */
type WithLock = {
	withOperationLock<T>(operation: () => Promise<T>): Promise<T>;
};

const makeService = () =>
	new SourceControlService(
		mock(),
		mock(),
		mock(),
		mock(),
		mock(),
		mock(),
		mock(),
		mock(),
		mock(),
	) as unknown as WithLock;

describe('SourceControlService operation lock', () => {
	beforeAll(() => {
		Container.set(InstanceSettings, mock<InstanceSettings>({ n8nFolder: '/tmp/n8n-test' }));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('takes a lease on the shared source-control key through LockService', async () => {
		const withLease = vi.spyOn(Container.get(LockService), 'withLease');

		await makeService().withOperationLock(async () => 'done');

		expect(withLease).toHaveBeenCalledWith(
			LockNamespace.KNOWN_LOCKS,
			'source-control:workfolder-operation',
			expect.any(Function),
			{ leaseTtlMs: 60_000 },
		);
	});

	it('never interleaves operations from two instances sharing a lock backend', async () => {
		// Two service instances stand in for two mains: what serializes them is the
		// shared LockService (Redis-backed under multi-main), not per-instance state.
		const mainA = makeService();
		const mainB = makeService();
		const events: string[] = [];
		const operation = (name: string) => async () => {
			events.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			events.push(`${name}:end`);
		};

		await Promise.all([
			mainA.withOperationLock(operation('a')),
			mainB.withOperationLock(operation('b')),
		]);

		expect(events).toHaveLength(4);
		expect(events[1]).toBe(`${events[0].split(':')[0]}:end`);
		expect(events[3]).toBe(`${events[2].split(':')[0]}:end`);
	});

	it('releases the lease when an operation throws', async () => {
		const service = makeService();

		await expect(
			service.withOperationLock(async () => {
				throw new Error('push failed');
			}),
		).rejects.toThrow('push failed');

		await expect(service.withOperationLock(async () => 'next')).resolves.toBe('next');
	});
});
