import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import { MultiMainMetadata, OnLeaderStepdown, OnLeaderTakeover } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import type { InstanceSettings, InstanceRole } from 'n8n-core';
import { UserError } from 'n8n-workflow';
import type { Mock } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { LeaderElectionClient } from '../leader-election-client';
import { MultiMainSetup } from '../multi-main-setup';

const HOST_ID = 'main-local';
const OTHER_HOST_ID = 'main-other';

/**
 * `instanceRole` is a mutable state machine that the service both reads and
 * writes, so a stateful stand-in is needed rather than a flat mock.
 */
class FakeInstanceSettings {
	instanceRole: InstanceRole = 'unset';

	readonly hostId = HOST_ID;

	isMultiMain = true;

	get isLeader() {
		return this.instanceRole === 'leader';
	}

	get isFollower() {
		return this.instanceRole === 'follower';
	}

	markAsLeader() {
		this.instanceRole = 'leader';
	}

	markAsFollower() {
		this.instanceRole = 'follower';
	}
}

const ok = <T>(result: T) => ({ ok: true as const, result });
const err = (message: string) => ({ ok: false as const, error: new Error(message) });

describe('MultiMainSetup', () => {
	let logger: Logger;
	let instanceSettings: FakeInstanceSettings;
	let leaderElectionClient: ReturnType<typeof mock<LeaderElectionClient>>;
	let metadata: MultiMainMetadata;
	let setup: MultiMainSetup;

	const build = ({ ttl = 10, interval = 3 }: { ttl?: number; interval?: number } = {}) => {
		const globalConfig = mock<GlobalConfig>({ multiMainSetup: { ttl, interval } });

		return new MultiMainSetup(
			logger,
			globalConfig,
			instanceSettings as unknown as InstanceSettings,
			metadata,
		);
	};

	beforeEach(() => {
		Container.reset();

		logger = mock<Logger>();
		(logger.scoped as Mock).mockReturnValue(logger);

		instanceSettings = new FakeInstanceSettings();

		leaderElectionClient = mock<LeaderElectionClient>();
		Container.set(LeaderElectionClient, leaderElectionClient);

		metadata = new MultiMainMetadata();
		Container.set(MultiMainMetadata, metadata);

		setup = build();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	// Drive one interval tick. Timers are faked per-test where needed.
	const tick = async (seconds = 3) => await vi.advanceTimersByTimeAsync(seconds * 1_000);

	describe('construction', () => {
		it('should not resolve the Redis-backed election client', () => {
			// `DebugController` injects this service on every instance, including
			// single-main and regular-mode ones that have no Redis at all. Resolving
			// `LeaderElectionClient` eagerly would open a connection on all of them.
			const resolve = vi.spyOn(Container, 'get');

			build();

			expect(resolve).not.toHaveBeenCalledWith(LeaderElectionClient);

			resolve.mockRestore();
		});
	});

	describe('config validation', () => {
		it('should accept the shipped defaults', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await expect(build({ ttl: 10, interval: 3 }).init()).resolves.not.toThrow();
		});

		it('should reject a renewal interval that is not shorter than the TTL', async () => {
			await expect(build({ ttl: 5, interval: 5 }).init()).rejects.toThrow(UserError);
			expect(leaderElectionClient.getLeader).not.toHaveBeenCalled();
		});

		it('should reject an interval that leaves fewer than two renewals per TTL', async () => {
			// 6s interval inside a 10s TTL: a single dropped renewal expires the key.
			await expect(build({ ttl: 10, interval: 6 }).init()).rejects.toThrow(UserError);
			expect(leaderElectionClient.getLeader).not.toHaveBeenCalled();
		});

		it('should reject a TTL below the minimum', async () => {
			await expect(build({ ttl: 1, interval: 1 }).init()).rejects.toThrow(UserError);
		});

		it('should reject an interval below one second', async () => {
			await expect(build({ ttl: 10, interval: 0 }).init()).rejects.toThrow(UserError);
		});
	});

	describe('init', () => {
		it('should become leader when the key is free and the atomic claim wins', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should become follower when the atomic claim loses the race', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(false));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('follower');
		});

		it('should become follower when another host holds the key', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
		});

		it('should reconcile to leader when the key already holds our own hostId', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(HOST_ID));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should reject rather than resolve with an unset role when Redis fails', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(err('Command timed out'));

			await expect(setup.init()).rejects.toThrow('Failed to determine leader during startup');
			expect(instanceSettings.instanceRole).toBe('unset');
		});

		it('should reject when the initial claim fails', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(err('Command timed out'));

			await expect(setup.init()).rejects.toThrow('Failed to claim leadership during startup');
			expect(instanceSettings.instanceRole).toBe('unset');
		});

		it('should not emit leader-takeover for the initial role assignment', async () => {
			// `Start` calls registerEventHandlers() only after init() resolves, so an
			// event here would reach zero handlers. Consumers self-init from `isLeader`.
			const listener = vi.fn();
			setup.on('leader-takeover', listener);

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('leader');
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('renewal', () => {
		beforeEach(async () => {
			vi.useFakeTimers();
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();
			leaderElectionClient.setLeaderIfNotExists.mockClear();
		});

		it('should stay leader without emitting anything while renewals succeed', async () => {
			const listener = vi.fn();
			setup.on('leader-stepdown', listener);
			setup.on('leader-takeover', listener);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'success' }));

			await tick();

			expect(leaderElectionClient.tryRenewLeaderTtl).toHaveBeenCalledTimes(1);
			expect(instanceSettings.instanceRole).toBe('leader');
			expect(listener).not.toHaveBeenCalled();
		});

		it('should step down when another host has taken the key', async () => {
			const listener = vi.fn();
			setup.on('leader-stepdown', listener);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('should step down on the very first renewal error', async () => {
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.tryRenewLeaderTtl).toHaveBeenCalledTimes(1);
		});

		it('should stay leader when an expired key is atomically reacquired', async () => {
			const listener = vi.fn();
			setup.on('leader-takeover', listener);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'key-missing' }));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick();

			expect(instanceSettings.instanceRole).toBe('leader');
			expect(listener).not.toHaveBeenCalled();
		});

		it('should step down when an expired key cannot be reacquired', async () => {
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'key-missing' }));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(false));

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
		});

		it('should step down when reacquiring an expired key errors', async () => {
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'key-missing' }));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(err('Command timed out'));

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
		});
	});

	describe('failover and recovery', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		it('should take over and emit when a follower wins the freed key', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));
			await setup.init();
			expect(instanceSettings.instanceRole).toBe('follower');

			const listener = vi.fn();
			setup.on('leader-takeover', listener);
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick();

			expect(instanceSettings.instanceRole).toBe('leader');
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('should recover leadership after a transient renewal error demoted it', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();

			const stepdown = vi.fn();
			const takeover = vi.fn();
			setup.on('leader-stepdown', stepdown);
			setup.on('leader-takeover', takeover);

			// A transient Redis failure demotes us even though our key survived.
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));
			await tick();
			expect(instanceSettings.instanceRole).toBe('follower');
			expect(stepdown).toHaveBeenCalledTimes(1);

			// The next check sees our own hostId still in the key and reconciles back.
			leaderElectionClient.getLeader.mockResolvedValue(ok(HOST_ID));
			await tick();

			expect(instanceSettings.instanceRole).toBe('leader');
			expect(takeover).toHaveBeenCalledTimes(1);
		});

		it('should stay follower and not throw when a periodic read fails', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));
			await setup.init();

			leaderElectionClient.getLeader.mockResolvedValue(err('Command timed out'));

			await expect(tick()).resolves.not.toThrow();
			expect(instanceSettings.instanceRole).toBe('follower');
		});
	});

	describe('interval scheduling', () => {
		it('should not start a second check while one is still in flight', async () => {
			vi.useFakeTimers();
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();

			let release = () => {};
			leaderElectionClient.tryRenewLeaderTtl.mockImplementation(
				async () =>
					await new Promise((resolve) => {
						release = () => resolve(ok({ id: 'success' }));
					}),
			);

			await tick(); // starts a check that never settles
			await tick(); // would overlap
			await tick();

			expect(leaderElectionClient.tryRenewLeaderTtl).toHaveBeenCalledTimes(1);

			release();
		});

		it('should not hold the event loop open with its interval timer', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await setup.init();

			const timer = Reflect.get(setup, 'leaderCheckTimer') as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);

			await setup.shutdown();
		});
	});

	describe('registerEventHandlers', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		const initAsLeader = async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();
		};

		it('should invoke handlers registered after subscription, bound to their instance', async () => {
			await initAsLeader();
			setup.registerEventHandlers();

			@Service()
			class LateService {
				calledOn: unknown = null;

				@OnLeaderStepdown()
				async stop() {
					this.calledOn = this;
				}
			}

			const lateService = Container.get(LateService);

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);
			await tick();

			expect(lateService.calledOn).toBe(lateService);
		});

		it('should await async handlers before the transition completes', async () => {
			let releaseHandler = () => {};

			@Service()
			class SlowService {
				finished = false;

				@OnLeaderTakeover()
				async start() {
					await new Promise<void>((resolve) => {
						releaseHandler = () => {
							this.finished = true;
							resolve();
						};
					});
				}
			}

			const slowService = Container.get(SlowService);

			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));
			await setup.init();
			setup.registerEventHandlers();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick();

			// The check is still in flight precisely because the handler has not settled.
			const inFlight = Reflect.get(setup, 'inFlightCheck') as Promise<void> | undefined;
			expect(inFlight).toBeDefined();
			expect(slowService.finished).toBe(false);

			releaseHandler();
			await inFlight;

			expect(slowService.finished).toBe(true);
			expect(Reflect.get(setup, 'inFlightCheck')).toBeUndefined();
		});

		it('should isolate a throwing handler from the other handlers and the transition', async () => {
			@Service()
			class BrokenService {
				@OnLeaderStepdown()
				async stop() {
					throw new Error('teardown exploded');
				}
			}

			@Service()
			class HealthyService {
				stopped = false;

				@OnLeaderStepdown()
				async stop() {
					this.stopped = true;
				}
			}

			Container.get(BrokenService);
			const healthyService = Container.get(HealthyService);

			await initAsLeader();
			setup.registerEventHandlers();

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await expect(tick()).resolves.not.toThrow();

			expect(healthyService.stopped).toBe(true);
			expect(instanceSettings.instanceRole).toBe('follower');
			expect(logger.error).toHaveBeenCalledWith(
				'Handler for "leader-stepdown" failed',
				expect.objectContaining({ error: new Error('teardown exploded') }),
			);
		});

		it('should reject a second subscription to handler registrations', async () => {
			await initAsLeader();

			setup.registerEventHandlers();

			expect(() => setup.registerEventHandlers()).toThrow(
				'A listener is already subscribed to handler registrations',
			);
		});
	});

	describe('shutdown', () => {
		const initAsLeader = async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();
		};

		it('should release the leader key only through the owner-checked delete', async () => {
			await initAsLeader();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await setup.shutdown();

			expect(leaderElectionClient.releaseLeaderIfOwner).toHaveBeenCalledTimes(1);
			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
		});

		it('should leave a key owned by a newer leader untouched', async () => {
			await initAsLeader();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await setup.shutdown();

			expect(logger.warn).toHaveBeenCalledWith(
				'Leader key was not ours on shutdown, left untouched',
				expect.anything(),
			);
			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
		});

		it('should not release anything when this instance is a follower', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));
			await setup.init();

			await setup.shutdown();

			expect(leaderElectionClient.releaseLeaderIfOwner).not.toHaveBeenCalled();
			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
		});

		it('should not emit leader-stepdown, leaving exit teardown to @OnShutdown', async () => {
			await initAsLeader();
			const listener = vi.fn();
			setup.on('leader-stepdown', listener);
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await setup.shutdown();

			expect(listener).not.toHaveBeenCalled();
		});

		it('should stop the periodic check so no transition happens after shutdown', async () => {
			vi.useFakeTimers();
			await initAsLeader();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'success' }));

			await setup.shutdown();
			await tick(30);

			expect(leaderElectionClient.tryRenewLeaderTtl).not.toHaveBeenCalled();
		});

		it('should not let a check in flight promote this instance while it exits', async () => {
			vi.useFakeTimers();

			// Start as a follower, then park the next check inside its leader read.
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));
			await setup.init();
			setup.registerEventHandlers();

			@Service()
			class TakeoverService {
				started = false;

				@OnLeaderTakeover()
				async start() {
					this.started = true;
				}
			}

			const takeoverService = Container.get(TakeoverService);

			let releaseRead = () => {};
			leaderElectionClient.getLeader.mockImplementation(
				async () =>
					await new Promise((resolve) => {
						releaseRead = () => resolve(ok(null));
					}),
			);
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick(); // check is now parked on getLeader()

			const shutdown = setup.shutdown();
			releaseRead(); // the parked read resolves: the key is free
			await shutdown;

			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
			expect(takeoverService.started).toBe(false);
			expect(instanceSettings.instanceRole).toBe('follower');
		});

		it('should still disconnect when the release fails', async () => {
			await initAsLeader();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(err('Command timed out'));

			await setup.shutdown();

			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
		});
	});

	describe('fetchLeaderKey', () => {
		it('should return the current leader hostId', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(OTHER_HOST_ID));

			await expect(setup.fetchLeaderKey()).resolves.toBe(OTHER_HOST_ID);
		});

		it('should return null when no leader key exists', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));

			await expect(setup.fetchLeaderKey()).resolves.toBeNull();
		});

		it('should throw rather than make a Redis outage look like "no leader"', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(err('Command timed out'));

			await expect(setup.fetchLeaderKey()).rejects.toThrow('Failed to fetch leader key from Redis');
		});

		it('should not touch Redis on a non-multi-main instance', async () => {
			instanceSettings.isMultiMain = false;

			await expect(setup.fetchLeaderKey()).resolves.toBeNull();
			expect(leaderElectionClient.getLeader).not.toHaveBeenCalled();
		});
	});
});
