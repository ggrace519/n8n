import type { GlobalConfig } from '@n8n/config';
import type { Redis } from 'ioredis';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { RedisClientService } from '@/services/redis-client.service';

import { LeaderElectionClient } from '../leader-election-client';

describe('LeaderElectionClient', () => {
	const hostId = 'main-local';

	let redisClient: ReturnType<typeof mock<Redis>>;
	let client: LeaderElectionClient;

	beforeEach(() => {
		redisClient = mock<Redis>();

		const redisClientService = mock<RedisClientService>();
		redisClientService.toValidPrefix.mockReturnValue('n8n');
		redisClientService.createClient.mockReturnValue(redisClient);

		client = new LeaderElectionClient(
			mock<InstanceSettings>({ hostId }),
			mock<GlobalConfig>({
				redis: { prefix: 'n8n' },
				multiMainSetup: { ttl: 10 },
			}),
			redisClientService,
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('releaseLeaderIfOwner', () => {
		it('should run an atomic compare-and-delete against the leader key', async () => {
			redisClient.eval.mockResolvedValue(1);

			await client.releaseLeaderIfOwner();

			expect(redisClient.eval).toHaveBeenCalledWith(
				expect.stringContaining('DEL'),
				1,
				'n8n:main_instance_leader',
				hostId,
			);
			// The delete must be conditional on ownership, never a bare DEL.
			expect(redisClient.del).not.toHaveBeenCalled();
		});

		it('should report release when the key was ours', async () => {
			redisClient.eval.mockResolvedValue(1);

			const result = await client.releaseLeaderIfOwner();

			expect(result).toEqual({ ok: true, result: { id: 'released' } });
		});

		it('should report a missing key without deleting anything', async () => {
			redisClient.eval.mockResolvedValue(-1);

			const result = await client.releaseLeaderIfOwner();

			expect(result).toEqual({ ok: true, result: { id: 'key-missing' } });
		});

		it('should refuse to delete a key held by another host', async () => {
			redisClient.eval.mockResolvedValue('main-other');

			const result = await client.releaseLeaderIfOwner();

			expect(result).toEqual({
				ok: true,
				result: { id: 'other-host-is-leader', currentLeaderId: 'main-other' },
			});
		});

		it('should treat a zero delete count as a missing key', async () => {
			redisClient.eval.mockResolvedValue(0);

			const result = await client.releaseLeaderIfOwner();

			expect(result).toEqual({ ok: true, result: { id: 'key-missing' } });
		});

		it('should return an error result for an unexpected script result', async () => {
			redisClient.eval.mockResolvedValue({ unexpected: true });

			const result = await client.releaseLeaderIfOwner();

			expect(result.ok).toBe(false);
		});

		it('should return an error result when Redis throws', async () => {
			redisClient.eval.mockRejectedValue(new Error('Command timed out'));

			const result = await client.releaseLeaderIfOwner();

			expect(result).toEqual({ ok: false, error: new Error('Command timed out') });
		});
	});
});
