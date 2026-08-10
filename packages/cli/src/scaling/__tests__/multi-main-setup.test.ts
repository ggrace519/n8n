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

/** A leader key held by another instance. */
const heldByOther = ok({ hostId: OTHER_HOST_ID, isOurs: false });

/** A leader key still carrying this process's own ownership token. */
const heldByUs = ok({ hostId: HOST_ID, isOurs: true });

/**
 * A leader key naming our own hostId but carrying somebody else's token — what a
 * second main sharing a Docker hostname, or a restarted process, actually sees.
 */
const sameHostIdDifferentOwner = ok({ hostId: HOST_ID, isOurs: false });

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
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// Drive one interval tick. Timers are faked per-test where needed.
	const tick = async (seconds = 3) => await vi.advanceTimersByTimeAsync(seconds * 1_000);

	/** Wait for queued transition handlers, which checks deliberately do not await. */
	const settleTransitions = async () => {
		await Reflect.get(setup, 'inFlightTransition');
	};

	/** Re-enable the fail-stop exit, which is disabled under test, and capture it. */
	const captureFailStop = () => {
		Reflect.set(setup, 'exitOnUnrecoverableError', true);

		return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
	};

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

		it('should reject a TTL a single command timeout could outlast', async () => {
			// A command may wait 5s, so a 2s TTL can expire while the renewal that was
			// meant to extend it is still in flight — the old rule accepted this.
			await expect(build({ ttl: 2, interval: 1 }).init()).rejects.toThrow(
				/a renewal may take up to 5s/,
			);
			expect(leaderElectionClient.getLeader).not.toHaveBeenCalled();
		});

		it('should reject a TTL with no room for interval + command timeout + margin', async () => {
			// 2 + 5 + 1 = 8, exactly the TTL, leaving nothing spare.
			await expect(build({ ttl: 8, interval: 2 }).init()).rejects.toThrow(UserError);
		});

		it('should accept a TTL one second above that floor', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await expect(build({ ttl: 9, interval: 2 }).init()).resolves.not.toThrow();
		});

		it('should reject an interval that leaves fewer than two renewals per TTL', async () => {
			// Comfortably inside the headroom rule, but a single dropped renewal at an
			// 11s cadence still expires a 20s key.
			await expect(build({ ttl: 20, interval: 11 }).init()).rejects.toThrow(
				/at most half of N8N_MULTI_MAIN_SETUP_KEY_TTL/,
			);
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
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
		});

		it('should not treat a key that merely shares our hostId as ours', async () => {
			// Two mains in Docker can share a hostname, and a restarted process reuses
			// its own. Only the ownership token decides, so this instance stays a
			// follower and never touches the other's key.
			leaderElectionClient.getLeader.mockResolvedValue(sameHostIdDifferentOwner);

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.tryRenewLeaderTtl).not.toHaveBeenCalled();
			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
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

		it('should reject when re-proving our own surviving key fails at startup', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));

			await expect(setup.init()).rejects.toThrow(
				'Failed to renew our own leader key during startup',
			);
			expect(instanceSettings.instanceRole).toBe('unset');
		});

		it('should not emit leader-takeover for the initial role assignment', async () => {
			// Every leader-only consumer self-initializes from `isLeader` during
			// startup, so an event here would duplicate that work.
			const listener = vi.fn();
			setup.on('leader-takeover', listener);

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await setup.init();

			expect(instanceSettings.instanceRole).toBe('leader');
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('promotion on our own key', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		const initAsFollower = async () => {
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();
			expect(instanceSettings.instanceRole).toBe('follower');
		};

		it('should promote only after a successful compare-and-renew, never on the read alone', async () => {
			await initAsFollower();

			const takeover = vi.fn();
			setup.on('leader-takeover', takeover);

			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'success' }));

			await tick();
			await settleTransitions();

			expect(leaderElectionClient.tryRenewLeaderTtl).toHaveBeenCalledTimes(1);
			expect(instanceSettings.instanceRole).toBe('leader');
			expect(takeover).toHaveBeenCalledTimes(1);
		});

		it('should stay follower when our key is read as ours but the renewal fails', async () => {
			// The window this closes: the key is about to expire, the read still shows
			// our token, and promoting on that read alone hands leadership to two mains.
			await initAsFollower();

			const takeover = vi.fn();
			setup.on('leader-takeover', takeover);

			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));

			await tick();
			await settleTransitions();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(takeover).not.toHaveBeenCalled();
		});

		it('should stay follower when our key was taken over between read and renewal', async () => {
			await initAsFollower();

			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
		});

		it('should fall through to an atomic claim when our key expired mid-reconcile', async () => {
			await initAsFollower();

			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'key-missing' }));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick();
			await settleTransitions();

			expect(leaderElectionClient.setLeaderIfNotExists).toHaveBeenCalledTimes(1);
			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should stay follower when the fall-through claim loses the race', async () => {
			await initAsFollower();

			leaderElectionClient.getLeader.mockResolvedValue(heldByUs);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'key-missing' }));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(false));

			await tick();

			expect(instanceSettings.instanceRole).toBe('follower');
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

		it('should keep leading indefinitely while renewals keep proving the lease', async () => {
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'success' }));

			await tick(60);

			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should step down when another host has taken the key', async () => {
			const listener = vi.fn();
			setup.on('leader-stepdown', listener);
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();
			await settleTransitions();

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

	describe('lease deadline', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		const initAsLeader = async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();
			leaderElectionClient.getLeader.mockReset();
			leaderElectionClient.setLeaderIfNotExists.mockReset();
		};

		/** A renewal that never resolves, as during a partition or a Redis stall. */
		const parkRenewal = () => {
			leaderElectionClient.tryRenewLeaderTtl.mockImplementation(
				async () => await new Promise(() => {}),
			);
		};

		it('should demote inside the safety margin, not merely at some point later', async () => {
			/**
			 * TTL 11s with a 3s election interval, deliberately chosen so the deadline
			 * does not land on an election tick: the lease is proven until t=11s, so
			 * demotion is due in the margin window [10s, 11s), while election ticks fall
			 * at 9s and 12s. A check that only ran on the election interval — or a
			 * watchdog slower than the 1s margin — would demote at 12s, a full second
			 * *after* the key Redis holds had already expired and been claimed.
			 */
			setup = build({ ttl: 11, interval: 3 });

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();

			const stepdown = vi.fn();
			setup.on('leader-stepdown', stepdown);

			parkRenewal();

			await tick(9.9);
			expect(instanceSettings.instanceRole).toBe('leader');

			await vi.advanceTimersByTimeAsync(500); // t = 10.4s, inside the margin

			expect(instanceSettings.instanceRole).toBe('follower');

			await settleTransitions();
			expect(stepdown).toHaveBeenCalledTimes(1);
		});

		it('should not demote while the lease still has more than the safety margin left', async () => {
			await initAsLeader();

			parkRenewal();

			await tick(7);

			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should keep renewing while a takeover handler runs longer than the TTL', async () => {
			// The handler used to run inside the overlap guard, so every renewal was
			// skipped until it settled and the key silently expired underneath it.
			@Service()
			class SlowTakeoverService {
				started = false;

				finished = false;

				@OnLeaderTakeover()
				async start() {
					this.started = true;
					await new Promise(() => {});
					this.finished = true;
				}
			}

			const slowService = Container.get(SlowTakeoverService);

			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(ok({ id: 'success' }));

			await tick(30);

			expect(slowService.started).toBe(true);
			expect(slowService.finished).toBe(false);
			// Renewals kept landing throughout, so the lease never lapsed.
			expect(leaderElectionClient.tryRenewLeaderTtl.mock.calls.length).toBeGreaterThan(5);
			expect(instanceSettings.instanceRole).toBe('leader');
		});

		it('should demote a leader whose handler outlives the lease once renewals stall', async () => {
			@Service()
			class SlowTakeoverService {
				started = false;

				@OnLeaderTakeover()
				async start() {
					this.started = true;
					await new Promise(() => {});
				}
			}

			const slowService = Container.get(SlowTakeoverService);

			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			parkRenewal();

			await tick(3); // promotes; the takeover handler parks
			expect(slowService.started).toBe(true);
			expect(instanceSettings.instanceRole).toBe('leader');

			// Nothing can re-prove the lease, so the watchdog gives it up rather than
			// letting this instance keep leading past the key's lifetime.
			await tick(12);

			expect(instanceSettings.instanceRole).toBe('follower');
		});

		it('should clear the proven deadline on stepdown so a follower is never demoted again', async () => {
			await initAsLeader();

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);

			await tick();
			expect(instanceSettings.instanceRole).toBe('follower');

			expect(Reflect.get(setup, 'leaseProvenUntilMs')).toBe(0);
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

			expect(leaderElectionClient.tryRenewLeaderTtl).toHaveBeenCalledTimes(1);

			release();
		});

		it('should not hold the event loop open with its timers', async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await setup.init();

			const checkTimer = Reflect.get(setup, 'leaderCheckTimer') as NodeJS.Timeout;
			const watchdogTimer = Reflect.get(setup, 'leaseWatchdogTimer') as NodeJS.Timeout;

			expect(checkTimer.hasRef()).toBe(false);
			expect(watchdogTimer.hasRef()).toBe(false);

			await setup.shutdown();
		});
	});

	describe('leadership handlers', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		const initAsLeader = async () => {
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			await setup.init();
		};

		it('should reach handlers registered before init without a separate wiring call', async () => {
			// The election timer used to start before `Start` subscribed, so an early
			// transition reached zero handlers and was lost.
			@Service()
			class EarlyService {
				stopped = false;

				@OnLeaderStepdown()
				async stop() {
					this.stopped = true;
				}
			}

			const earlyService = Container.get(EarlyService);

			await initAsLeader();

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();
			await settleTransitions();

			expect(earlyService.stopped).toBe(true);
		});

		it('should invoke handlers registered after init, bound to their instance', async () => {
			await initAsLeader();

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
			await settleTransitions();

			expect(lateService.calledOn).toBe(lateService);
		});

		it('should run a stepdown queued behind a takeover only after it finishes', async () => {
			// Concurrent setup and teardown would tear down half-built state; FIFO
			// ordering guarantees the stepdown undoes a completed takeover.
			const order: string[] = [];
			let releaseTakeover = () => {};

			@Service()
			class OrderedService {
				@OnLeaderTakeover()
				async start() {
					order.push('takeover-start');
					await new Promise<void>((resolve) => {
						releaseTakeover = resolve;
					});
					order.push('takeover-end');
				}

				@OnLeaderStepdown()
				async stop() {
					order.push('stepdown');
				}
			}

			Container.get(OrderedService);

			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));

			await tick(); // promotes; the takeover handler parks
			expect(order).toEqual(['takeover-start']);

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(err('Command timed out'));
			await tick(); // demotes while the takeover handler is still running

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(order).toEqual(['takeover-start']);

			releaseTakeover();
			await settleTransitions();

			expect(order).toEqual(['takeover-start', 'takeover-end', 'stepdown']);
		});

		it('should run every stepdown handler even when one of them throws', async () => {
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

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await expect(tick()).resolves.not.toThrow();
			await settleTransitions();

			expect(healthyService.stopped).toBe(true);
			expect(instanceSettings.instanceRole).toBe('follower');
			expect(logger.error).toHaveBeenCalledWith(
				'Handler for "leader-stepdown" failed',
				expect.objectContaining({ error: new Error('teardown exploded') }),
			);
		});

		it('should fail-stop when stepdown teardown fails', async () => {
			// A logged rejection is not enough: failed teardown means triggers and
			// timers keep running here beside the main that now holds the lease, so
			// every schedule fires twice. Nothing local can recover that.
			@Service()
			class BrokenService {
				@OnLeaderStepdown()
				async stop() {
					throw new Error('teardown exploded');
				}
			}

			Container.get(BrokenService);

			await initAsLeader();
			const exit = captureFailStop();

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();
			await settleTransitions();

			expect(logger.error).toHaveBeenCalledWith(
				'Leader stepdown teardown failed',
				expect.anything(),
			);
			expect(exit).toHaveBeenCalledWith(1);
		});

		it('should not fail-stop when every stepdown handler succeeds', async () => {
			@Service()
			class HealthyService {
				@OnLeaderStepdown()
				async stop() {}
			}

			Container.get(HealthyService);

			await initAsLeader();
			const exit = captureFailStop();

			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick();
			await settleTransitions();

			expect(exit).not.toHaveBeenCalled();
		});

		it('should demote and release the lease when a takeover handler fails', async () => {
			// Holding the lease while half-initialized leaves the cluster with a leader
			// that does not lead; giving it up lets another main take over cleanly.
			@Service()
			class BrokenTakeoverService {
				@OnLeaderTakeover()
				async start() {
					throw new Error('startup exploded');
				}
			}

			@Service()
			class TeardownService {
				stopped = false;

				@OnLeaderStepdown()
				async stop() {
					this.stopped = true;
				}
			}

			Container.get(BrokenTakeoverService);
			const teardownService = Container.get(TeardownService);

			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();
			const exit = captureFailStop();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await tick();
			await settleTransitions();

			expect(instanceSettings.instanceRole).toBe('follower');
			expect(leaderElectionClient.releaseLeaderIfOwner).toHaveBeenCalledTimes(1);
			expect(teardownService.stopped).toBe(true);
			expect(exit).not.toHaveBeenCalled();
		});

		it('should fail-stop when teardown after a failed takeover also fails', async () => {
			@Service()
			class BrokenTakeoverService {
				@OnLeaderTakeover()
				async start() {
					throw new Error('startup exploded');
				}
			}

			@Service()
			class BrokenTeardownService {
				@OnLeaderStepdown()
				async stop() {
					throw new Error('teardown exploded');
				}
			}

			Container.get(BrokenTakeoverService);
			Container.get(BrokenTeardownService);

			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();
			const exit = captureFailStop();

			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(true));
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await tick();
			await settleTransitions();

			expect(exit).toHaveBeenCalledWith(1);
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

		it('should still attempt the owner-checked release as a follower, without warning', async () => {
			// A follower has nothing of its own to delete, so the compare-and-delete
			// matches nothing — but running it unconditionally is what catches a claim
			// that won the key after shutdown had already begun.
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'key-missing' }));

			await setup.shutdown();

			expect(leaderElectionClient.releaseLeaderIfOwner).toHaveBeenCalledTimes(1);
			expect(logger.warn).not.toHaveBeenCalled();
			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
		});

		it('should release a claim that succeeded after shutdown had begun', async () => {
			vi.useFakeTimers();

			// Start as a follower, then park the next check inside its atomic claim.
			leaderElectionClient.getLeader.mockResolvedValue(ok(null));
			leaderElectionClient.setLeaderIfNotExists.mockResolvedValue(ok(false));
			await setup.init();
			expect(instanceSettings.instanceRole).toBe('follower');

			@Service()
			class TakeoverService {
				started = false;

				@OnLeaderTakeover()
				async start() {
					this.started = true;
				}
			}

			const takeoverService = Container.get(TakeoverService);

			let releaseClaim = () => {};
			leaderElectionClient.setLeaderIfNotExists.mockImplementation(
				async () =>
					await new Promise((resolve) => {
						releaseClaim = () => resolve(ok(true));
					}),
			);
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));

			await tick(); // the check is now parked inside setLeaderIfNotExists()

			const shutdown = setup.shutdown();
			releaseClaim(); // the parked claim wins the key while we are exiting
			await shutdown;

			// Never promote an exiting process...
			expect(takeoverService.started).toBe(false);
			expect(instanceSettings.instanceRole).toBe('follower');
			// ...but the key it just won must not be left to expire on its TTL, or no
			// surviving main can take over until then.
			expect(leaderElectionClient.releaseLeaderIfOwner).toHaveBeenCalledTimes(1);
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
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);
			await setup.init();

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
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'key-missing' }));

			await tick(); // check is now parked on getLeader()

			const shutdown = setup.shutdown();
			releaseRead(); // the parked read resolves: the key is free
			await shutdown;

			expect(leaderElectionClient.setLeaderIfNotExists).not.toHaveBeenCalled();
			expect(takeoverService.started).toBe(false);
			expect(instanceSettings.instanceRole).toBe('follower');
		});

		it('should drain a running transition before releasing and disconnecting', async () => {
			vi.useFakeTimers();

			let releaseHandler = () => {};

			@Service()
			class SlowTeardownService {
				finished = false;

				@OnLeaderStepdown()
				async stop() {
					await new Promise<void>((resolve) => {
						releaseHandler = () => {
							this.finished = true;
							resolve();
						};
					});
				}
			}

			const slowService = Container.get(SlowTeardownService);

			await initAsLeader();
			leaderElectionClient.releaseLeaderIfOwner.mockResolvedValue(ok({ id: 'released' }));
			leaderElectionClient.tryRenewLeaderTtl.mockResolvedValue(
				ok({ id: 'other-host-is-leader', currentLeaderId: OTHER_HOST_ID }),
			);

			await tick(); // demotes; the teardown handler parks

			const shutdown = setup.shutdown();
			await vi.advanceTimersByTimeAsync(0);

			expect(leaderElectionClient.destroy).not.toHaveBeenCalled();

			releaseHandler();
			await shutdown;

			expect(slowService.finished).toBe(true);
			expect(leaderElectionClient.destroy).toHaveBeenCalledTimes(1);
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
			leaderElectionClient.getLeader.mockResolvedValue(heldByOther);

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
