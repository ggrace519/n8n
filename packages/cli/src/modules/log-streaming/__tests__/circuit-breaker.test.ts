import { DeliveryCircuitBreaker } from '../circuit-breaker';

describe('DeliveryCircuitBreaker', () => {
	const t0 = 1_000_000;

	it('stays closed while failures remain below maxFailures', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 3 });
		breaker.record(false, t0);
		breaker.record(false, t0 + 1);
		expect(breaker.currentState).toBe('closed');
		expect(breaker.allowRequest(t0 + 2)).toBe(true);
	});

	it('resets the failure streak on success', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 2 });
		breaker.record(false, t0);
		breaker.record(true, t0 + 1);
		breaker.record(false, t0 + 2);
		expect(breaker.currentState).toBe('closed');
	});

	it('opens after maxFailures consecutive failures and blocks requests', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 2, openDurationMs: 1000 });
		breaker.record(false, t0);
		breaker.record(false, t0 + 1);
		expect(breaker.currentState).toBe('open');
		expect(breaker.allowRequest(t0 + 2)).toBe(false);
	});

	it('half-opens after the open duration and admits a single probe', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 1, openDurationMs: 1000 });
		breaker.record(false, t0);
		expect(breaker.allowRequest(t0 + 999)).toBe(false);
		expect(breaker.allowRequest(t0 + 1000)).toBe(true); // probe admitted
		expect(breaker.currentState).toBe('half-open');
		expect(breaker.allowRequest(t0 + 1001)).toBe(false); // second concurrent probe denied
	});

	it('closes after a successful half-open probe', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 1, openDurationMs: 1000 });
		breaker.record(false, t0);
		expect(breaker.allowRequest(t0 + 1000)).toBe(true);
		breaker.record(true, t0 + 1001);
		expect(breaker.currentState).toBe('closed');
		expect(breaker.allowRequest(t0 + 1002)).toBe(true);
	});

	it('reopens after a failed half-open probe', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 1, openDurationMs: 1000 });
		breaker.record(false, t0);
		expect(breaker.allowRequest(t0 + 1000)).toBe(true);
		breaker.record(false, t0 + 1001);
		expect(breaker.currentState).toBe('open');
		expect(breaker.allowRequest(t0 + 1500)).toBe(false);
		expect(breaker.allowRequest(t0 + 2001)).toBe(true); // half-open again after cooldown
	});

	it('admits the configured number of half-open probes', () => {
		const breaker = new DeliveryCircuitBreaker({
			maxFailures: 1,
			openDurationMs: 1000,
			halfOpenRequests: 2,
		});
		breaker.record(false, t0);
		expect(breaker.allowRequest(t0 + 1000)).toBe(true);
		expect(breaker.allowRequest(t0 + 1001)).toBe(true);
		expect(breaker.allowRequest(t0 + 1002)).toBe(false);
	});

	it('discards a failure streak older than the failure window', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 2, failureWindowMs: 100 });
		breaker.record(false, t0);
		breaker.record(false, t0 + 500); // outside the window: streak restarts at 1
		expect(breaker.currentState).toBe('closed');
		breaker.record(false, t0 + 550); // within the window of the restarted streak
		expect(breaker.currentState).toBe('open');
	});

	it('ignores late failures reported while already open', () => {
		const breaker = new DeliveryCircuitBreaker({ maxFailures: 1, openDurationMs: 1000 });
		breaker.record(false, t0);
		breaker.record(false, t0 + 1); // late report from a pre-open request
		expect(breaker.currentState).toBe('open');
		// the open timer was not restarted by the late report
		expect(breaker.allowRequest(t0 + 1000)).toBe(true);
	});
});
