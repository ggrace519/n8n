import { Logger, TypedEmitter } from '@n8n/backend-common';
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

import { LeaderElectionClient } from './leader-election-client';

export type MultiMainEvents = {
	[LEADER_TAKEOVER_EVENT_NAME]: never;
	[LEADER_STEPDOWN_EVENT_NAME]: never;
};

/**
 * Smallest leader-key TTL we accept. Every leader-election command has a 5s
 * timeout, so a shorter TTL cannot be renewed reliably and would flap.
 */
const MIN_TTL_SECONDS = 2;

/**
 * A leader must get at least this many renewal attempts inside one TTL window.
 * With only one attempt, a single dropped renewal expires the key and silently
 * hands leadership to another main.
 */
const MIN_RENEWALS_PER_TTL = 2;

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
 */
@Service()
export class MultiMainSetup extends TypedEmitter<MultiMainEvents> {
	private leaderCheckTimer: NodeJS.Timeout | undefined;

	/** Set once shutdown starts, so no further check can re-acquire leadership. */
	private isShuttingDown = false;

	/** In-flight periodic check, used to prevent overlap and to drain on shutdown. */
	private inFlightCheck: Promise<void> | undefined;

	/** Decorator-registered handlers, awaited on each transition. */
	private readonly leadershipHandlers = new Map<MultiMainEvent, Array<() => Promise<unknown>>>();

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

		await this.checkLeader({ isInitial: true });

		this.leaderCheckTimer = setInterval(() => {
			void this.runPeriodicCheck();
		}, this.intervalSeconds * 1_000);

		// Never hold the event loop open on our account; the HTTP server keeps the
		// process alive, and a lingering interval would delay a clean exit.
		this.leaderCheckTimer.unref?.();

		this.logger.debug(
			`Leader election started as ${this.instanceSettings.instanceRole}, checking every ${this.intervalSeconds}s`,
		);
	}

	/**
	 * Wire up every method decorated with `@OnLeaderTakeover` / `@OnLeaderStepdown`.
	 *
	 * Deliberately separate from {@link init}: `Start` elects a leader early (the
	 * license check needs the role) but only registers handlers after all modules
	 * have loaded, so late-loading services still get their handlers wired.
	 *
	 * Handlers are collected here rather than registered via `on()` so transitions
	 * can await them; `on()` stays available for plain observers.
	 */
	registerEventHandlers() {
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

		// Drain any check still running, so it cannot transition state behind us.
		await this.inFlightCheck;

		if (this.instanceSettings.isLeader) await this.releaseLeadership();

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

		return result.result;
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
		const renewal = await this.leaderElectionClient.tryRenewLeaderTtl();

		if (!renewal.ok) {
			// Fail closed on the very first error. A leader that cannot prove ownership
			// may already have been replaced, and continuing leader-only work would
			// double-run schedules and triggers. Re-acquisition is one interval away.
			this.logger.error('Failed to renew leader key, stepping down', {
				error: renewal.error,
			});
			await this.stepDown();
			return;
		}

		const result = renewal.result;

		if (result.id === 'success') return; // unchanged state emits no event

		if (result.id === 'other-host-is-leader') {
			this.logger.warn('Another instance is now the leader, stepping down', {
				currentLeaderId: result.currentLeaderId,
			});
			await this.stepDown();
			return;
		}

		// The key expired (e.g. a renewal was slow enough for Redis to drop it).
		// Only an atomic NX claim proves we may keep leading.
		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

		if (claim.ok && claim.result) {
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

		await this.stepDown();
	}

	/** Claim leadership if it is free or already recorded as ours. */
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

		const currentLeaderId = leader.result;

		if (currentLeaderId === this.instanceSettings.hostId) {
			// Remote says we lead but local state disagrees — e.g. we stepped down on a
			// transient Redis error while our key survived. Reconcile towards Redis.
			await this.takeOver({ isInitial });
			return;
		}

		if (currentLeaderId !== null) {
			this.settleAsFollower();
			return;
		}

		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

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
		if (claim.result) await this.takeOver({ isInitial });
		else this.settleAsFollower();
	}

	private async runPeriodicCheck() {
		// Skip rather than queue: an older check completing after a newer transition
		// could resurrect a stale role.
		if (this.inFlightCheck !== undefined || this.isShuttingDown) return;

		const check = this.checkLeader({ isInitial: false }).catch((error: unknown) => {
			this.logger.error('Leader check failed', { error });
		});

		this.inFlightCheck = check;

		try {
			await check;
		} finally {
			this.inFlightCheck = undefined;
		}
	}

	// #endregion

	// #region Transitions

	private async takeOver({ isInitial }: { isInitial: boolean }) {
		// Backstop for a claim that resolved as shutdown began: never promote an
		// exiting process. The key we may have just won expires on its own TTL.
		if (this.isShuttingDown) {
			this.logger.debug('Skipping leader takeover because shutdown is in progress');
			return;
		}

		// Local state must change before the event, because several pubsub handlers
		// and consumers read `isLeader` dynamically while handlers run.
		this.instanceSettings.markAsLeader();

		/**
		 * The initial assignment emits nothing. `Start` calls `registerEventHandlers()`
		 * only after `init()` resolves, so an event here would reach zero handlers, and
		 * every leader-only consumer already self-initializes from `isLeader`.
		 */
		if (isInitial) {
			this.logger.info('Starting as leader');
			return;
		}

		this.logger.info('Leader key acquired, taking over as leader');
		await this.runLeadershipHandlers(LEADER_TAKEOVER_EVENT_NAME);
	}

	private async stepDown() {
		this.instanceSettings.markAsFollower();

		this.logger.info('Stepped down as leader');
		await this.runLeadershipHandlers(LEADER_STEPDOWN_EVENT_NAME);
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
	 * Run every handler for an event and wait for all of them.
	 *
	 * Handlers run concurrently and in no guaranteed order: stepdown teardown is
	 * time-sensitive, so one slow handler must not delay the rest. A throwing
	 * handler is logged and does not abort the transition or the other handlers —
	 * the role has already changed, and aborting would leave the instance
	 * half-transitioned.
	 */
	private async runLeadershipHandlers(eventName: MultiMainEvent) {
		// During shutdown consumers tear down through `@OnShutdown` instead; running
		// these as well would duplicate that work on an exiting process.
		if (this.isShuttingDown) return;

		const handlers = this.leadershipHandlers.get(eventName) ?? [];

		const outcomes = await Promise.allSettled(handlers.map(async (handler) => await handler()));

		for (const outcome of outcomes) {
			if (outcome.status === 'rejected') {
				this.logger.error(`Handler for "${eventName}" failed`, { error: outcome.reason });
			}
		}

		// Notify plain `on()` observers only after the registered work has settled.
		this.emit(eventName);
	}

	private async releaseLeadership() {
		const release = await this.leaderElectionClient.releaseLeaderIfOwner();

		if (!release.ok) {
			this.logger.error('Failed to release leader key on shutdown', { error: release.error });
			return;
		}

		if (release.result.id === 'released') {
			this.logger.debug('Released leader key on shutdown');
		} else {
			// Never force the delete: the key may already belong to a newer leader.
			this.logger.warn('Leader key was not ours on shutdown, left untouched', {
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

		if (ttlSeconds < MIN_TTL_SECONDS) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_KEY_TTL must be at least ${MIN_TTL_SECONDS} seconds, but is ${ttlSeconds}.`,
			);
		}

		if (intervalSeconds < 1) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL must be at least 1 second, but is ${intervalSeconds}.`,
			);
		}

		if (intervalSeconds * MIN_RENEWALS_PER_TTL > ttlSeconds) {
			throw new UserError(
				`N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL (${intervalSeconds}s) must be at most half of N8N_MULTI_MAIN_SETUP_KEY_TTL (${ttlSeconds}s), so the leader gets ${MIN_RENEWALS_PER_TTL} renewal attempts before the key expires.`,
			);
		}
	}
}
