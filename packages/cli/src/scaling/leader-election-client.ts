import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import type { Cluster, Redis } from 'ioredis';
import { InstanceSettings } from 'n8n-core';
import { randomBytes } from 'node:crypto';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { type Result, createResultOk, createResultError } from '@n8n/utils/result';

import { RedisClientService } from '@/services/redis-client.service';

/**
 * How long a leader-election command may wait before ioredis aborts it. The
 * election state machine must know this to size its renewal cadence against the
 * key TTL, so it is exported rather than kept private.
 */
export const LEADER_COMMAND_TIMEOUT_MS = 5_000;

/** Separates the diagnostic hostId from the unguessable ownership token. */
const OWNER_VALUE_SEPARATOR = '#';

/**
 * Atomically extends the leader key TTL only if the current value matches this
 * process's ownership token.
 *
 * KEYS[1] - leader key
 * ARGV[1] - owner value (hostId + ownership token)
 * ARGV[2] - TTL in seconds
 *
 * Returns:
 * -1                  key does not exist
 * "actual-value"      key exists but is held by another owner
 * 1                   owner matched and TTL was extended
 * 0                   owner matched but the key was gone before `EXPIRE` ran.
 *                     Unreachable, because the script is atomic and the `GET`
 *                     above proved the key exists; treated as a missing key.
 */
const INCREASE_TTL_IF_LEADER = `
-- Renew only if we still hold the lock
local currentValue = redis.call("GET", KEYS[1])

if not currentValue then
  return -1
end

if currentValue ~= ARGV[1] then
  return currentValue
end

return redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
`;

/**
 * Atomically deletes the leader key only if the current value matches this
 * process's ownership token. An unconditional `DEL` is unsafe: a process whose
 * local role is stale would delete a *newer* leader's key, leaving the cluster
 * leaderless or letting a third instance claim leadership while the newer leader
 * still believes it holds the key.
 *
 * A `GET` followed by a `DEL` is not a substitute — the value can change between
 * the two round trips.
 *
 * KEYS[1] - leader key
 * ARGV[1] - owner value (hostId + ownership token)
 *
 * Returns:
 * -1                  key does not exist
 * "actual-value"      key exists but is held by another owner
 * 1                   owner matched and the key was deleted
 */
const DELETE_IF_LEADER = `
-- Release only if we still hold the lock
local currentValue = redis.call("GET", KEYS[1])

if not currentValue then
  return -1
end

if currentValue ~= ARGV[1] then
  return currentValue
end

return redis.call("DEL", KEYS[1])
`;

export type TtlRenewalResultKeyMissing = { id: 'key-missing' };
export type TtlRenewalResultOtherHostIsLeader = {
	id: 'other-host-is-leader';
	currentLeaderId: string;
};
export type TtlRenewalResultSuccess = { id: 'success' };

export type TtlRenewalResult =
	| TtlRenewalResultKeyMissing
	| TtlRenewalResultOtherHostIsLeader
	| TtlRenewalResultSuccess;

export type LeaderReleaseResult =
	| { id: 'released' }
	| { id: 'key-missing' }
	| { id: 'other-host-is-leader'; currentLeaderId: string };

/** What the leader key currently holds, as seen by this process. */
export type LeaderKeyInfo = {
	/** Owning instance's hostId. Diagnostics and logging only — never an ownership proof. */
	hostId: string;
	/** Whether the stored value carries *this* process's current ownership token. */
	isOurs: boolean;
};

/**
 * Redis-backed client for leader election in multi-main setups. Uses a TTL-based key to
 * track which instance is the current leader.
 *
 * Ownership is proven by an unguessable token minted at each claim, never by
 * `hostId`. Docker derives `hostId` from the hostname, so two mains can share
 * one; a hostId-keyed lock would let the second read the first's key as "ours"
 * and let both renew and delete it. Replacing an instance on a reused hostname
 * is the same problem across time. The token is stored alongside the hostId so
 * the debug endpoint can still name the leader.
 */
@Service()
export class LeaderElectionClient {
	private readonly redisClient: Redis | Cluster;

	private readonly leaderKey: string;

	private readonly leaderKeyTtlInS: number;

	/**
	 * The exact value this process writes when it claims the key, and the only
	 * value either Lua script accepts as proof of ownership.
	 *
	 * Always defined, so no code path has to reason about a missing token: until
	 * a claim succeeds it simply holds a token that was never written to Redis
	 * and therefore cannot match anything.
	 */
	private ownerValue: string;

	private get hostId() {
		return this.instanceSettings.hostId;
	}

	constructor(
		private readonly instanceSettings: InstanceSettings,
		globalConfig: GlobalConfig,
		redisClientService: RedisClientService,
	) {
		const prefix = redisClientService.toValidPrefix(globalConfig.redis.prefix);
		this.leaderKey = prefix + ':main_instance_leader';

		this.leaderKeyTtlInS = globalConfig.multiMainSetup.ttl;

		this.ownerValue = this.mintOwnerValue();

		this.redisClient = redisClientService.createClient({
			type: 'leader(n8n)',
			extraOptions: { commandTimeout: LEADER_COMMAND_TIMEOUT_MS },
		});
	}

	/** Read the leader key, reporting who holds it and whether that is us. */
	async getLeader(): Promise<Result<LeaderKeyInfo | null, Error>> {
		try {
			const value = await this.redisClient.get(this.leaderKey);

			return createResultOk(value === null ? null : this.describeOwner(value));
		} catch (e) {
			return createResultError(ensureError(e));
		}
	}

	/** Claim leadership with a TTL. Returns `true` if the key was set (i.e. no leader yet). */
	async setLeaderIfNotExists(): Promise<Result<boolean, Error>> {
		// Mint before writing, so the value we store is the one we later compare
		// against. A timed-out claim that actually reached Redis is then still
		// recognized as ours on the next read, instead of being orphaned.
		const ownerValue = this.mintOwnerValue();

		try {
			const result = await this.redisClient.set(
				this.leaderKey,
				ownerValue,
				'EX',
				this.leaderKeyTtlInS,
				'NX',
			);
			return createResultOk(result === 'OK');
		} catch (e) {
			return createResultError(ensureError(e));
		}
	}

	/** Atomically extend the leader key TTL only if this process still owns it. */
	async tryRenewLeaderTtl(): Promise<Result<TtlRenewalResult, Error>> {
		try {
			const result = await this.redisClient.eval(
				INCREASE_TTL_IF_LEADER,
				1,
				this.leaderKey,
				this.ownerValue,
				this.leaderKeyTtlInS,
			);

			if (result === -1 || result === 0) {
				return createResultOk({ id: 'key-missing' });
			}
			if (result === 1) {
				return createResultOk({ id: 'success' });
			}
			if (typeof result === 'string') {
				return createResultOk({
					id: 'other-host-is-leader',
					currentLeaderId: this.describeOwner(result).hostId,
				});
			}

			return createResultError(
				new Error(`Unexpected result from Redis script: ${JSON.stringify(result)}`),
			);
		} catch (e) {
			return createResultError(ensureError(e));
		}
	}

	/**
	 * Atomically delete the leader key, but only if this process still owns it, so
	 * another instance can claim leadership immediately instead of waiting out the
	 * TTL. Releasing a key held by another owner would cause a split brain.
	 */
	async releaseLeaderIfOwner(): Promise<Result<LeaderReleaseResult, Error>> {
		try {
			const result = await this.redisClient.eval(
				DELETE_IF_LEADER,
				1,
				this.leaderKey,
				this.ownerValue,
			);

			// `DEL` returning 0 is unreachable inside the script (the GET above proved
			// the key exists), but report it as missing rather than as an error: either
			// way this host no longer holds the key.
			if (result === -1 || result === 0) return createResultOk({ id: 'key-missing' });
			if (result === 1) return createResultOk({ id: 'released' });
			if (typeof result === 'string') {
				return createResultOk({
					id: 'other-host-is-leader',
					currentLeaderId: this.describeOwner(result).hostId,
				});
			}

			return createResultError(
				new Error(`Unexpected result from Redis script: ${JSON.stringify(result)}`),
			);
		} catch (e) {
			return createResultError(ensureError(e));
		}
	}

	/** Disconnect the underlying Redis client. */
	destroy() {
		this.redisClient.disconnect();
	}

	private mintOwnerValue() {
		this.ownerValue = `${this.hostId}${OWNER_VALUE_SEPARATOR}${randomBytes(16).toString('hex')}`;

		return this.ownerValue;
	}

	/**
	 * Split a stored value into its diagnostic hostId and an ownership verdict.
	 * A value written by an older or foreign format carries no separator; its
	 * whole content is reported as the hostId and it is never treated as ours.
	 */
	private describeOwner(value: string): LeaderKeyInfo {
		const separatorIndex = value.lastIndexOf(OWNER_VALUE_SEPARATOR);

		return {
			hostId: separatorIndex === -1 ? value : value.slice(0, separatorIndex),
			isOurs: value === this.ownerValue,
		};
	}
}
