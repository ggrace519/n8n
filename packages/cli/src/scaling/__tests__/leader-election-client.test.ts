import type { GlobalConfig } from '@n8n/config';
import type { Redis } from 'ioredis';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { RedisClientService } from '@/services/redis-client.service';

import { LeaderElectionClient } from '../leader-election-client';

describe('LeaderElectionClient', () => {
	const hostId = 'main-local';
	const LEADER_KEY = 'n8n:main_instance_leader';

	let redisClient: ReturnType<typeof mock<Redis>>;
	let client: LeaderElectionClient;

	/**
	 * Builds a client on its own Redis mock, so two of them can be pointed at the
	 * same simulated key to reproduce a competing-main race.
	 */
	const buildClient = (ownHostId = hostId) => {
		const ownRedisClient = mock<Redis>();

		const redisClientService = mock<RedisClientService>();
		redisClientService.toValidPrefix.mockReturnValue('n8n');
		redisClientService.createClient.mockReturnValue(ownRedisClient);

		const leaderElectionClient = new LeaderElectionClient(
			mock<InstanceSettings>({ hostId: ownHostId }),
			mock<GlobalConfig>({
				redis: { prefix: 'n8n' },
				multiMainSetup: { ttl: 10 },
			}),
			redisClientService,
		);

		return { leaderElectionClient, redisClient: ownRedisClient };
	};

	/** The value a client wrote on its last successful claim. */
	const claimedValue = (mockedRedis: ReturnType<typeof mock<Redis>>) => {
		const [, value] = mockedRedis.set.mock.calls.at(-1) as [string, string];
		return value;
	};

	beforeEach(() => {
		const built = buildClient();
		client = built.leaderElectionClient;
		redisClient = built.redisClient;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('ownership token', () => {
		it('should store an unguessable token alongside the hostId, never the bare hostId', async () => {
			redisClient.set.mockResolvedValue('OK');

			await client.setLeaderIfNotExists();

			const value = claimedValue(redisClient);

			expect(value).not.toBe(hostId);
			expect(value.startsWith(`${hostId}#`)).toBe(true);
			// 16 random bytes, hex-encoded.
			expect(value.slice(hostId.length + 1)).toMatch(/^[0-9a-f]{32}$/);
		});

		it('should mint a fresh token on every claim so an expired lease cannot be renewed by its old token', async () => {
			redisClient.set.mockResolvedValue('OK');

			await client.setLeaderIfNotExists();
			const firstValue = claimedValue(redisClient);

			await client.setLeaderIfNotExists();
			const secondValue = claimedValue(redisClient);

			expect(secondValue).not.toBe(firstValue);

			// The client now compares against the newest token only: a key still
			// holding the previous one is no longer ours.
			redisClient.get.mockResolvedValue(firstValue);
			await expect(client.getLeader()).resolves.toEqual({
				ok: true,
				result: { hostId, isOurs: false },
			});
		});

		it('should recognize a key it wrote itself as ours', async () => {
			redisClient.set.mockResolvedValue('OK');
			await client.setLeaderIfNotExists();

			redisClient.get.mockResolvedValue(claimedValue(redisClient));

			await expect(client.getLeader()).resolves.toEqual({
				ok: true,
				result: { hostId, isOurs: true },
			});
		});

		it('should not let two mains sharing one hostId both hold the lease', async () => {
			// Docker derives hostId from the hostname, so this is a real deployment
			// shape rather than a synthetic one.
			const a = buildClient(hostId);
			const b = buildClient(hostId);

			a.redisClient.set.mockResolvedValue('OK');
			await a.leaderElectionClient.setLeaderIfNotExists();
			const keyValue = claimedValue(a.redisClient);

			// B reads the key A holds. Same hostId, different token.
			b.redisClient.get.mockResolvedValue(keyValue);
			const bRead = await b.leaderElectionClient.getLeader();

			expect(bRead).toEqual({ ok: true, result: { hostId, isOurs: false } });

			// B's NX claim loses, and neither its renewal nor its release may touch
			// A's key: both compare B's own token, which the key does not carry.
			b.redisClient.set.mockResolvedValue(null);
			await expect(b.leaderElectionClient.setLeaderIfNotExists()).resolves.toEqual({
				ok: true,
				result: false,
			});

			b.redisClient.eval.mockResolvedValue(keyValue);

			await expect(b.leaderElectionClient.tryRenewLeaderTtl()).resolves.toEqual({
				ok: true,
				result: { id: 'other-host-is-leader', currentLeaderId: hostId },
			});
			await expect(b.leaderElectionClient.releaseLeaderIfOwner()).resolves.toEqual({
				ok: true,
				result: { id: 'other-host-is-leader', currentLeaderId: hostId },
			});

			for (const [, , , comparedValue] of b.redisClient.eval.mock.calls) {
				expect(comparedValue).not.toBe(keyValue);
			}
		});

		it('should report a value written in an unknown format as a foreign host', async () => {
			redisClient.get.mockResolvedValue('main-legacy');

			await expect(client.getLeader()).resolves.toEqual({
				ok: true,
				result: { hostId: 'main-legacy', isOurs: false },
			});
		});

		it('should report no leader when the key is absent', async () => {
			redisClient.get.mockResolvedValue(null);

			await expect(client.getLeader()).resolves.toEqual({ ok: true, result: null });
		});

		it('should return an error result when the read fails', async () => {
			redisClient.get.mockRejectedValue(new Error('Command timed out'));

			const result = await client.getLeader();

			expect(result).toEqual({ ok: false, error: new Error('Command timed out') });
		});
	});

	describe('tryRenewLeaderTtl', () => {
		it('should compare the ownership token, not the hostId', async () => {
			redisClient.set.mockResolvedValue('OK');
			await client.setLeaderIfNotExists();
			const ownerValue = claimedValue(redisClient);

			redisClient.eval.mockResolvedValue(1);

			await client.tryRenewLeaderTtl();

			expect(redisClient.eval).toHaveBeenCalledWith(
				expect.stringContaining('EXPIRE'),
				1,
				LEADER_KEY,
				ownerValue,
				10,
			);
		});

		it('should report success when the TTL was extended', async () => {
			redisClient.eval.mockResolvedValue(1);

			await expect(client.tryRenewLeaderTtl()).resolves.toEqual({
				ok: true,
				result: { id: 'success' },
			});
		});

		it('should treat a missing key as key-missing', async () => {
			redisClient.eval.mockResolvedValue(-1);

			await expect(client.tryRenewLeaderTtl()).resolves.toEqual({
				ok: true,
				result: { id: 'key-missing' },
			});
		});

		it('should treat a zero result as key-missing', async () => {
			// `EXPIRE` only returns 0 for a key that no longer exists.
			redisClient.eval.mockResolvedValue(0);

			await expect(client.tryRenewLeaderTtl()).resolves.toEqual({
				ok: true,
				result: { id: 'key-missing' },
			});
		});

		it('should report the other owner by hostId, not by raw token', async () => {
			redisClient.eval.mockResolvedValue('main-other#deadbeef');

			await expect(client.tryRenewLeaderTtl()).resolves.toEqual({
				ok: true,
				result: { id: 'other-host-is-leader', currentLeaderId: 'main-other' },
			});
		});

		it('should return an error result for an unexpected script result', async () => {
			redisClient.eval.mockResolvedValue({ unexpected: true });

			const result = await client.tryRenewLeaderTtl();

			expect(result.ok).toBe(false);
		});

		it('should return an error result when Redis throws', async () => {
			redisClient.eval.mockRejectedValue(new Error('Command timed out'));

			await expect(client.tryRenewLeaderTtl()).resolves.toEqual({
				ok: false,
				error: new Error('Command timed out'),
			});
		});
	});

	describe('releaseLeaderIfOwner', () => {
		it('should run an atomic compare-and-delete against the leader key', async () => {
			redisClient.set.mockResolvedValue('OK');
			await client.setLeaderIfNotExists();
			const ownerValue = claimedValue(redisClient);

			redisClient.eval.mockResolvedValue(1);

			await client.releaseLeaderIfOwner();

			expect(redisClient.eval).toHaveBeenCalledWith(
				expect.stringContaining('DEL'),
				1,
				LEADER_KEY,
				ownerValue,
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

		it('should refuse to delete a key held by another owner', async () => {
			redisClient.eval.mockResolvedValue('main-other#deadbeef');

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
