import { inTest, Logger, TypedEmitter } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import {
	LEADER_STEPDOWN_EVENT_NAME,
	LEADER_TAKEOVER_EVENT_NAME,
	MultiMainMetadata,
} from '@n8n/decorators';
import type { MultiMainEvent } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { OperationalError, UserError } from 'n8n-workflow';

import { LEADER_COMMAND_TIMEOUT_MS, LeaderElectionClient } from './leader-election-client';

export type MultiMainEvents = {
	[LEADER_TAKEOVER_EVENT_NAME]: never;
	[LEADER_STEPDOWN_EVENT_NAME]: never;
};

/**
 * A leader must get at least this many renewal attempts inside one TTL window.
 * With only one attempt, a single dropped renewal expires the key and silently
 * hands leadership to another main.
 */
const MIN_RENEWALS_PER_TTL = 2;

/**
 * How much of the lease this instance refuses to spend. Leadership is given up
 * once less than this remains of the last *proven* lease, so leader-only work
 * always stops before the key can expire and be claimed by another main.
 */
const LEASE_SAFETY_MARGIN_MS = 1_000;

/**
 * How often the lease deadline is re-evaluated.
 *
 * Deliberately much shorter than {@link LEASE_SAFETY_MARGIN_MS}: the check has
 * to fire *inside* the margin to demote before the deadline, so a slower timer
 * would push demotion past the very deadline it protects. The election interval
 * cannot serve this purpose — it is coarser, and it is skipped entirely while a
 * Redis command hangs, which is exactly when the lease is running out.
 */
const LEASE_WATCHDOG_INTERVAL_MS = 500;

/**
 * Elects one `main` instance as the leader in a multi-main setup and keeps the
 * local {@link InstanceSettings.instanceRole} in sync with the Redis leader key.
 *
 * Election primitives (read, atomic NX claim, owner-checked TTL renewal,
 * owner-checked release) live in {@link LeaderElectionClient}. This class owns
 * everything above them: scheduling, initial role assignment, local/remote
 * reconciliation, transitions, leadership events and shutdown policy.
 *
 * Every ambiguous outcome fails closed — the process demotes itself rather than
 * optimistically retaining leadership — because two instances believing they
 * lead means schedules, triggers and webhooks run twice.
 *
 * Local leadership is bounded by the lease: the role is only ever held while a
 * renewal has recently *proven* ownership, never merely because a read once said
 * so. Note that this bound is enforced by this process's own clock, so a long
 * process pause or a Redis failover can still open a window in which this
 * instance believes it leads after the key has moved. Closing that window needs
 * fencing tokens threaded through leader-only work, which this class cannot do
 * on its own.
 */
@Service()
export class MultiMainSetup extends TypedEmitter<MultiMainEvents> {
	private leaderCheckTimer: NodeJS.Timeout | undefined;

	private leaseWatchdogTimer: NodeJS.Timeout | undefined;

	/** Set once shutdown starts, so no further check can re-acquire leadership. */
	private isShuttingDown = false;

	/** In-flight periodic check, used to prevent overlap and to drain on shutdown. */
	private inFlightCheck: Promise<void> | undefined;

	/** Tail of the serialized transition queue, used to drain handlers on shutdown. */
	private inFlightTransition: Promise<void> | undefined;

	/**
	 * Absolute time until which this instance has *proven* it holds the lease.
	 * Zero when nothing is proven. Derived from the moment a renewal or claim was
	 * sent, never from when it resolved, because Redis started the TTL at some
	 * point at or after that — so this deadline is always at or before the real one.
	 */
	private leaseProvenUntilMs = 0;

	/** Decorator-registered handlers, awaited on each transition. */
	private readonly leadershipHandlers = new Map<MultiMainEvent, Array<() => Promise<unknown>>>();

	/**
	 * Whether an unrecoverable transition failure may stop the process. Disabled
	 * under test so a deliberately throwing handler does not kill the test worker.
	 */
	private readonly exitOnUnrecoverableError = !inTest;

	private leaderElectionClientInstance: LeaderElectionClient | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettings: InstanceSettings,
		private readonly multiMainMetadata: MultiMainMetadata,
	) {
		super();

		this.logger = this.logger.scoped(['scaling', 'multi-main-setup']);
	}

	/**
	 * Resolved lazily, not constructor-injected: creating the client opens a Redis
	 * connection, and `DebugController` injects this service on every instance,
	 * including single-main and regular-mode ones that have no Redis at all.
	 */
	private get leaderElectionClient(): LeaderElectionClient {
		this.leaderElectionClientInstance ??= Container.get(LeaderElectionClient);
		return this.leaderElectionClientInstance;
	}

	private get ttlSeconds() {
		return this.globalConfig.multiMainSetup.ttl;
	}

	private get intervalSeconds() {
		return this.globalConfig.multiMainSetup.interval;
	}

	// #region Lifecycle

	/**
	 * Assign a definitive leader/follower role and start renewing or contesting it.
	 *
	 * Resolves only once the role is known, because `Start` initializes the license
	 * and every other role-dependent service straight after awaiting this. Returning
	 * with `instanceRole === 'unset'` would silently disable leader-only work, so an
	 * initial election failure rejects instead.
	 */
	async init() {
		this.validateConfig();

		this.isShuttingDown = false;
		this.leaseProvenUntilMs = 0;

		await this.checkLeader({ isInitial: true });

		// Subscribe before any timer can fire. A transition that reaches zero
		// handlers is silently lost: leader-only work either keeps running after a
		// stepdown or never starts after a takeover, with nothing left to correct it.
		this.registerEventHandlers();

		this.leaderCheckTimer = setInterval(() => {
			this.runPeriodicCheck();
		}, this.intervalSeconds * 1_000);

		this.leaseWatchdogTimer = setInterval(() => {
			this.enforceLeaseDeadline();
		}, LEASE_WATCHDOG_INTERVAL_MS);

		// Never hold the event loop open on our account; the HTTP server keeps the
		// process alive, and lingering intervals would delay a clean exit.
		this.leaderCheckTimer.unref?.();
		this.leaseWatchdogTimer.unref?.();

		this.logger.debug(
			`Leader election started as ${this.instanceSettings.instanceRole}, checking every ${this.intervalSeconds}s`,
		);
	}

	/**
	 * Wire up every method decorated with `@OnLeaderTakeover` / `@OnLeaderStepdown`.
	 *
	 * Handlers are collected here rather than registered via `on()` so transitions
	 * can await them; `on()` stays available for plain observers.
	 *
	 * Subscribing this early is safe for late-loading services:
	 * `MultiMainMetadata.subscribe()` replays everything registered so far and
	 * keeps notifying on each later registration, so modules that load after
	 * `init()` still get their handlers wired.
	 */
	private registerEventHandlers() {
		this.multiMainMetadata.subscribe(({ eventHandlerClass, methodName, eventName }) => {
			const handlers = this.leadershipHandlers.get(eventName) ?? [];

			handlers.push(async () => {
				const instance = Container.get(eventHandlerClass);
				return await instance[methodName].call(instance);
			});

			this.leadershipHandlers.set(eventName, handlers);
		});
	}

	/**
	 * Stop contesting leadership and release the leader key if we still own it, so a
	 * surviving main can take over immediately instead of waiting out the TTL.
	 *
	 * Does not emit `leader-stepdown`: consumers that need teardown on exit already
	 * declare `@OnShutdown`, and `Start.stopProcess()` has removed trigger workflows
	 * before calling this. Emitting here would run their teardown twice.
	 */
	async shutdown() {
		this.isShuttingDown = true;

		if (this.leaderCheckTimer) {
			clearInterval(this.leaderCheckTimer);
			this.leaderCheckTimer = undefined;
		}

		if (this.leaseWatchdogTimer) {
			clearInterval(this.leaseWatchdogTimer);
			this.leaseWatchdogTimer = undefined;
		}

		// Drain the check first: a check that is still running is what enqueues the
		// newest transition, so reading the queue before it settles would miss one.
		await this.inFlightCheck;
		await this.inFlightTransition;

		await this.releaseLeadership();

		this.leaderElectionClient.destroy();
	}

	// #endregion

	// #region Leader key

	/**
	 * Return the hostId of the current leader, or `null` when no leader key exists.
	 *
	 * Throws on a Redis failure rather than returning `null`: reporting "no leader"
	 * when the truth is "cannot tell" would make an outage look like a normal
	 * leaderless moment to whoever is reading the debug endpoint.
	 */
	async fetchLeaderKey(): Promise<string | null> {
		// Without multi-main there is no leader key, and resolving the client here
		// would open a Redis connection on an instance that may have no Redis.
		if (!this.instanceSettings.isMultiMain) return null;

		const result = await this.leaderElectionClient.getLeader();

		if (!result.ok) {
			throw new OperationalError('Failed to fetch leader key from Redis', {
				cause: result.error,
			});
		}

		return result.result?.hostId ?? null;
	}

	// #endregion

	// #region Election

	/**
	 * Reconcile local role with the Redis leader key exactly once.
	 *
	 * On the initial call a Redis failure rejects, so startup fails loudly instead
	 * of continuing with an unset role. On periodic calls it never rejects: the next
	 * interval tick is the retry, and a leader that cannot prove ownership demotes.
	 */
	private async checkLeader({ isInitial }: { isInitial: boolean }) {
		if (this.instanceSettings.isLeader) {
			await this.renewLeadership();
			return;
		}

		await this.contestLeadership({ isInitial });
	}

	/** Renew our own leadership, or demote if we can no longer prove we hold it. */
	private async renewLeadership() {
		const renewalSentAt = Date.now();
		const renewal = await this.leaderElectionClient.tryRenewLeaderTtl();

		if (!renewal.ok) {
			// Fail closed on the very first error. A leader that cannot prove ownership
			// may already have been replaced, and continuing leader-only work would
			// double-run schedules and triggers. Re-acquisition is one interval away.
			this.logger.error('Failed to renew leader key, stepping down', {
				error: renewal.error,
			});
			this.stepDown();
			return;
		}

		const result = renewal.result;

		if (result.id === 'success') {
			this.recordLeaseProof(renewalSentAt);
			return; // unchanged state emits no event
		}

		if (result.id === 'other-host-is-leader') {
			this.logger.warn('Another instance is now the leader, stepping down', {
				currentLeaderId: result.currentLeaderId,
			});
			this.stepDown();
			return;
		}

		// The key expired (e.g. a renewal was slow enough for Redis to drop it).
		// Only an atomic NX claim proves we may keep leading.
		const claimSentAt = Date.now();
		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

		if (claim.ok && claim.result) {
			this.recordLeaseProof(claimSentAt);
			this.logger.debug('Leader key had expired and was reacquired');
			return; // still leader, no transition
		}

		if (!claim.ok) {
			this.logger.error('Failed to reacquire expired leader key, stepping down', {
				error: claim.error,
			});
		} else {
			this.logger.warn('Leader key had expired and was claimed by another instance');
		}

		this.stepDown();
	}

	/** Claim leadership if it is free, or re-prove a key that still carries our token. */
	private async contestLeadership({ isInitial }: { isInitial: boolean }) {
		const leader = await this.leaderElectionClient.getLeader();

		// This read may have been in flight when shutdown began. Claiming the key now
		// would hand leader-only work to a process that is exiting, and the claim
		// would then have to be released again immediately.
		if (this.isShuttingDown) return;

		if (!leader.ok) {
			if (isInitial) {
				throw new OperationalError('Failed to determine leader during startup', {
					cause: leader.error,
				});
			}

			this.logger.error('Failed to read leader key, staying follower', { error: leader.error });
			this.settleAsFollower();
			return;
		}

		if (leader.result !== null) {
			if (!leader.result.isOurs) {
				this.settleAsFollower();
				return;
			}

			/**
			 * The key still carries our ownership token — e.g. we demoted on a transient
			 * Redis error while the key survived.
			 *
			 * A read is *not* proof that we still hold it: the key can expire
			 * milliseconds later, another main can claim it, and we would already have
			 * promoted ourselves on the strength of a stale read. Only an atomic
			 * compare-and-renew, which both verifies ownership and pushes the deadline
			 * out, justifies promotion.
			 */
			const outcome = await this.reclaimOwnKey({ isInitial });

			if (this.isShuttingDown) return;

			if (outcome === 'reclaimed') {
				this.takeOver({ isInitial });
				return;
			}

			if (outcome === 'lost') {
				this.settleAsFollower();
				return;
			}

			// `expired`: the key went away between the read and the renewal. Fall
			// through to the atomic claim, the only thing that can prove we lead.
		}

		const claimSentAt = Date.now();
		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

		if (this.isShuttingDown) return;

		if (!claim.ok) {
			if (isInitial) {
				throw new OperationalError('Failed to claim leadership during startup', {
					cause: claim.error,
				});
			}

			this.logger.error('Failed to claim leader key, staying follower', { error: claim.error });
			this.settleAsFollower();
			return;
		}

		// A failed NX claim is never proof that we lead — another main won the race.
		if (claim.result) {
			this.recordLeaseProof(claimSentAt);
			this.takeOver({ isInitial });
		} else {
			this.settleAsFollower();
		}
	}

	/**
	 * Compare-and-renew a key that reads as ours, reporting whether ownership was
	 * actually re-proven, lost to another owner, or the key expired meanwhile.
	 */
	private async reclaimOwnKey({
		isInitial,
	}: {
		isInitial: boolean;
	}): Promise<'reclaimed' | 'lost' | 'expired'> {
		const renewalSentAt = Date.now();
		const renewal = await this.leaderElectionClient.tryRenewLeaderTtl();

		if (!renewal.ok) {
			if (isInitial) {
				throw new OperationalError('Failed to renew our own leader key during startup', {
					cause: renewal.error,
				});
			}

			this.logger.error('Failed to renew our own leader key, staying follower', {
				error: renewal.error,
			});
			return 'lost';
		}

		if (renewal.result.id === 'success') {
			this.recordLeaseProof(renewalSentAt);
			return 'reclaimed';
		}

		if (renewal.result.id === 'other-host-is-leader') {
			this.logger.warn('Our leader key was taken over by another instance, staying follower', {
				currentLeaderId: renewal.result.currentLeaderId,
			});
			return 'lost';
		}

		return 'expired';
	}

	private runPeriodicCheck() {
		// Evaluated before the overlap guard, so a hung Redis command — precisely
		// when the lease is running out — cannot suppress the deadline check.
		this.enforceLeaseDeadline();

		// Skip rather than queue: an older check completing after a newer transition
		// could resurrect a stale role.
		if (this.inFlightCheck !== undefined || this.isShuttingDown) return;

		const check = this.checkLeader({ isInitial: false }).catch((error: unknown) => {
			this.logger.error('Leader check failed', { error });
		});

		this.inFlightCheck = check;

		void check.finally(() => {
			this.inFlightCheck = undefined;
		});
	}

	/** Record how long ownership is proven for, from when the proof was *sent*. */
	private recordLeaseProof(sentAtMs: number) {
		this.leaseProvenUntilMs = sentAtMs + this.ttlSeconds * 1_000;
	}

	/**
	 * Give up leadership before the proven lease runs out.
	 *
	 * Without this, local leadership outlives the Redis key whenever renewals stop
	 * landing — a hung command, a partition, a stalled event loop — and this
	 * instance keeps running schedules and triggers while another main, having seen
	 * the key expire, starts running them too.
	 */
	private enforceLeaseDeadline() {
		if (this.isShuttingDown || !this.instanceSettings.isLeader) return;

		if (Date.now() < this.leaseProvenUntilMs - LEASE_SAFETY_MARGIN_MS) return;

		this.logger.error('Leader lease is expiring without a proven renewal, stepping down', {
			leaseProvenUntil: new Date(this.leaseProvenUntilMs).toISOString(),
		});

		this.stepDown();
	}

	// #endregion

	// #region Transitions

	private takeOver({ isInitial }: { isInitial: boolean }) {
		// Backstop for a claim that resolved as shutdown began: never promote an
		// exiting process. Shutdown releases the key we may have just won.
		if (this.isShuttingDown) {
			this.logger.debug('Skipping leader takeover because shutdown is in progress');
			return;
		}

		// Local state must change before the event, because several pubsub handlers
		// and consumers read `isLeader` dynamically while handlers run.
		this.instanceSettings.markAsLeader();

		/**
		 * The initial assignment emits nothing: every leader-only consumer
		 * self-initializes from `isLeader` during startup, so an event here would
		 * duplicate that work.
		 */
		if (isInitial) {
			this.logger.info('Starting as leader');
			return;
		}

		this.logger.info('Leader key acquired, taking over as leader');
		this.enqueueTransition(LEADER_TAKEOVER_EVENT_NAME);
	}

	private stepDown() {
		this.instanceSettings.markAsFollower();
		this.leaseProvenUntilMs = 0;

		this.logger.info('Stepped down as leader');
		this.enqueueTransition(LEADER_STEPDOWN_EVENT_NAME);
	}

	/**
	 * Record follower status. Only reachable when the role is `unset` or already
	 * `follower` (a leader demotes via {@link stepDown}), so this never needs to
	 * emit a stepdown event.
	 */
	private settleAsFollower() {
		if (this.instanceSettings.isFollower) return;

		this.instanceSettings.markAsFollower();
		this.logger.info('Starting as follower');
	}

	/**
	 * Queue a transition's handlers and return immediately.
	 *
	 * Deliberately not awaited by the election check: renewal has to keep proving
	 * the lease while handlers run. Awaiting them inside the check meant one slow
	 * handler suppressed every renewal until it settled, so the key expired while
	 * this instance still believed it led.
	 *
	 * Batches run one after another rather than concurrently, so a stepdown queued
	 * behind a takeover tears down only what that takeover finished setting up. The
	 * trade-off is that a superseded takeover's handlers can observe
	 * `isLeader === false`; the role is authoritative at decision time, and the
	 * queued stepdown then undoes whatever they started.
	 */
	private enqueueTransition(eventName: MultiMainEvent) {
		const previous = this.inFlightTransition ?? Promise.resolve();

		this.inFlightTransition = previous
			.then(async () => await this.runLeadershipHandlers(eventName))
			.catch((error: unknown) => {
				// Nothing above can await this queue, so a rejection has to end here.
				this.logger.error(`Leadership transition "${eventName}" failed`, { error });
			});
	}

	/**
	 * Run one transition's handlers and act on any that failed.
	 *
	 * A failure is not a log line: whichever way it falls, leader-only work is left
	 * running on an instance that should not be doing it.
	 */
	private async runLeadershipHandlers(eventName: MultiMainEvent) {
		// During shutdown consumers tear down through `@OnShutdown` instead; running
		// these as well would duplicate that work on an exiting process.
		if (this.isShuttingDown) return;

		const failures = await this.runHandlers(eventName);

		if (failures.length === 0) {
			// Notify plain `on()` observers only after the registered work has settled.
			this.emit(eventName);
			return;
		}

		if (eventName === LEADER_STEPDOWN_EVENT_NAME) {
			// Stepdown handlers are what stop leader-only work. If one fails, triggers,
			// pollers or timers stay live here alongside the main that now holds the
			// lease, and every schedule runs twice. Nothing local can recover that.
			this.failStop('Leader stepdown teardown failed', failures);
			return;
		}

		this.logger.error('Leader takeover failed, demoting and releasing the lease', {
			errors: failures,
		});

		// Holding the lease while half-initialized starves the cluster of a working
		// leader. Give it up so another main can take over cleanly.
		this.instanceSettings.markAsFollower();
		this.leaseProvenUntilMs = 0;

		await this.releaseLeadership();

		// Run teardown inline rather than through the queue: this already executes on
		// the transition queue, so enqueueing behind ourselves would deadlock.
		const teardownFailures = await this.runHandlers(LEADER_STEPDOWN_EVENT_NAME);

		if (teardownFailures.length > 0) {
			this.failStop('Leader stepdown teardown failed after a failed takeover', teardownFailures);
			return;
		}

		this.emit(LEADER_STEPDOWN_EVENT_NAME);
	}

	/**
	 * Run every handler for an event and wait for all of them, collecting failures.
	 *
	 * Handlers run concurrently and in no guaranteed order: stepdown teardown is
	 * time-sensitive, so one slow handler must not delay the rest. A throwing
	 * handler does not abort the others — the role has already changed, and the
	 * remaining teardown is still worth running.
	 */
	private async runHandlers(eventName: MultiMainEvent): Promise<unknown[]> {
		const handlers = this.leadershipHandlers.get(eventName) ?? [];

		const outcomes = await Promise.allSettled(handlers.map(async (handler) => await handler()));

		const failures: unknown[] = [];

		for (const outcome of outcomes) {
			if (outcome.status === 'rejected') {
				this.logger.error(`Handler for "${eventName}" failed`, { error: outcome.reason });
				failures.push(outcome.reason);
			}
		}

		return failures;
	}

	/**
	 * Stop the process, because leader-only work may still be running here while
	 * another main holds the lease.
	 *
	 * Duplicated schedules, triggers and webhooks corrupt data; an exit that a
	 * supervisor restarts into a clean follower does not.
	 */
	private failStop(reason: string, errors: unknown[]) {
		this.logger.error(reason, { errors });
		this.logger.error(
			'Exiting process: leader-only work cannot be confirmed stopped after stepping down',
		);

		if (this.exitOnUnrecoverableError) process.exit(1);
	}

	private async releaseLeadership() {
		const wasLeader = this.instanceSettings.isLeader;

		/**
		 * Attempted unconditionally, not only when we believe we lead. A claim that
		 * was still in flight when shutdown began can succeed after `takeOver()` has
		 * already refused to promote; the local role then says `follower` while this
		 * exiting process owns the key, blocking takeover until the TTL expires.
		 *
		 * For an instance that genuinely holds nothing this is one extra
		 * compare-and-delete that matches nothing and changes nothing.
		 */
		const release = await this.leaderElectionClient.releaseLeaderIfOwner();

		if (!release.ok) {
			this.logger.error('Failed to release leader key on shutdown', { error: release.error });
			return;
		}

		if (release.result.id === 'released') {
			this.logger.debug('Released leader key on shutdown');
			return;
		}

		// Never force the delete: the key may already belong to a newer leader.
		if (wasLeader) {
			this.logger.warn('Leader key was not ours on shutdown, left untouched', {
				result: release.result.id,
			});
		} else {
			this.logger.debug('No leader key of ours to release on shutdown', {
				result: release.result.id,
			});
		}
	}

	// #endregion

	/**
	 * Reject a renewal cadence that cannot keep the leader key alive. Neither the
	 * config class nor Redis enforces this, and getting it wrong makes leadership
	 * flap silently between mains instead of failing visibly.
	 */
	private validateConfig() {
		const { ttlSeconds, intervalSeconds } = this;

		if (intervalSeconds < 1) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL must be at least 1 second, but is ${intervalSeconds}.`,
			);
		}

		/**
		 * A renewal that starts one interval late and then blocks for the full
		 * command timeout must still land inside the TTL, with the safety margin left
		 * over. Without this, a configuration like TTL 2s / interval 1s is accepted
		 * even though a single command may wait 5s — the key expires, another main
		 * takes over, and this one only finds out seconds later.
		 */
		const commandTimeoutSeconds = LEADER_COMMAND_TIMEOUT_MS / 1_000;
		const marginSeconds = LEASE_SAFETY_MARGIN_MS / 1_000;
		const requiredHeadroom = intervalSeconds + commandTimeoutSeconds + marginSeconds;

		if (requiredHeadroom >= ttlSeconds) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_KEY_TTL (${ttlSeconds}s) is too short for N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL (${intervalSeconds}s): a renewal may take up to ${commandTimeoutSeconds}s, so the TTL must exceed ${requiredHeadroom}s to leave a ${marginSeconds}s safety margin.`,
			);
		}

		if (intervalSeconds * MIN_RENEWALS_PER_TTL > ttlSeconds) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL (${intervalSeconds}s) must be at most half of N8N_MULTI_MAIN_SETUP_KEY_TTL (${ttlSeconds}s), so the leader gets ${MIN_RENEWALS_PER_TTL} renewal attempts before the key expires.`,
			);
		}
	}
}
