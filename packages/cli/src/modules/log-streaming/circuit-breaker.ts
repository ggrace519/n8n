export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

const DEFAULT_OPEN_DURATION_MS = 30_000;

export interface DeliveryCircuitBreakerOptions {
	/** Consecutive failures after which the breaker opens. */
	maxFailures: number;
	/** How long the breaker stays open before allowing half-open probes. */
	openDurationMs?: number;
	/** How many probe requests the half-open state admits. */
	halfOpenRequests?: number;
	/** When set, a failure streak older than this window is discarded. */
	failureWindowMs?: number;
}

/**
 * Minimal per-destination circuit breaker.
 *
 * closed → open after `maxFailures` consecutive failures; open → half-open
 * after `openDurationMs`; half-open admits up to `halfOpenRequests` probes and
 * closes on a successful probe or reopens on a failed one. While open,
 * deliveries are skipped and their messages stay unconfirmed, so the bus's
 * unsent-retry loop redelivers them once the endpoint recovers.
 *
 * The `maxConcurrentHalfOpenRequests` schema field is accepted for
 * compatibility but not used: deliveries are serialized per destination, so at
 * most one probe is in flight at a time anyway.
 */
export class DeliveryCircuitBreaker {
	private state: CircuitBreakerState = 'closed';

	private consecutiveFailures = 0;

	private firstFailureAt = 0;

	private openedAt = 0;

	private halfOpenInFlight = 0;

	private readonly maxFailures: number;

	private readonly openDurationMs: number;

	private readonly halfOpenRequests: number;

	private readonly failureWindowMs?: number;

	constructor(options: DeliveryCircuitBreakerOptions) {
		this.maxFailures = options.maxFailures;
		this.openDurationMs = options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
		this.halfOpenRequests = options.halfOpenRequests ?? 1;
		this.failureWindowMs = options.failureWindowMs;
	}

	get currentState(): CircuitBreakerState {
		return this.state;
	}

	/** Whether a delivery may be attempted now. Admits half-open probes. */
	allowRequest(now = Date.now()): boolean {
		if (this.state === 'closed') return true;

		if (this.state === 'open') {
			if (now - this.openedAt < this.openDurationMs) return false;
			this.state = 'half-open';
			this.halfOpenInFlight = 0;
		}

		if (this.halfOpenInFlight >= this.halfOpenRequests) return false;
		this.halfOpenInFlight++;
		return true;
	}

	/** Report the outcome of a delivery admitted by `allowRequest`. */
	record(success: boolean, now = Date.now()): void {
		if (this.state === 'half-open') {
			this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
			if (success) this.reset();
			else this.trip(now);
			return;
		}

		if (success) {
			this.consecutiveFailures = 0;
			return;
		}

		// a late failure from a request admitted before the breaker opened
		if (this.state === 'open') return;

		if (
			this.failureWindowMs !== undefined &&
			this.consecutiveFailures > 0 &&
			now - this.firstFailureAt > this.failureWindowMs
		) {
			this.consecutiveFailures = 0;
		}
		if (this.consecutiveFailures === 0) this.firstFailureAt = now;
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= this.maxFailures) this.trip(now);
	}

	private trip(now: number): void {
		this.state = 'open';
		this.openedAt = now;
		this.consecutiveFailures = 0;
		this.halfOpenInFlight = 0;
	}

	private reset(): void {
		this.state = 'closed';
		this.consecutiveFailures = 0;
		this.halfOpenInFlight = 0;
	}
}
