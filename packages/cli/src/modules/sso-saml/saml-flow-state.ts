import { Service } from '@n8n/di';

/** How long an issued AuthnRequest may be answered by the IdP. */
export const SAML_AUTHN_REQUEST_TTL_MS = 15 * 60_000;

/** Upper bound on how long a consumed message ID is remembered. */
export const SAML_CONSUMED_ID_MAX_TTL_MS = 30 * 60_000;

/** Guard rails so a hostile peer cannot grow either map without bound. */
const MAX_PENDING_REQUESTS = 10_000;
const MAX_CONSUMED_IDS = 50_000;

export type AuthnRequestConsumption =
	| { outcome: 'consumed' }
	| { outcome: 'unknown-request' }
	| { outcome: 'flow-mismatch' };

/**
 * Per-process state for the SAML login flow: AuthnRequest IDs this instance
 * issued (optionally bound to a browser flow identifier) and the response /
 * assertion IDs already consumed.
 *
 * The state is in-memory, so in a multi-main deployment each main only knows
 * about the flows it started; sticky sessions or a single main are required
 * for the one-time guarantees to hold across the whole instance.
 */
@Service()
export class SamlFlowState {
	private readonly pendingRequests = new Map<string, { flowId?: string; expiresAt: number }>();

	private readonly consumedIds = new Map<string, number>();

	/** Remember an AuthnRequest this instance issued, optionally bound to a browser flow. */
	registerAuthnRequest(requestId: string, flowId?: string, now = Date.now()): void {
		this.evictExpired(now);
		if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
			// drop the oldest entry rather than let the map grow without bound
			const oldest = this.pendingRequests.keys().next();
			if (!oldest.done) this.pendingRequests.delete(oldest.value);
		}
		this.pendingRequests.set(requestId, {
			flowId,
			expiresAt: now + SAML_AUTHN_REQUEST_TTL_MS,
		});
	}

	/**
	 * Consume an AuthnRequest ID exactly once. When the request was issued with
	 * a flow identifier and the caller presents one, the two must match; a
	 * caller that presents none is accepted on the request ID alone.
	 */
	consumeAuthnRequest(
		requestId: string,
		flowId?: string,
		now = Date.now(),
	): AuthnRequestConsumption {
		this.evictExpired(now);
		const pending = this.pendingRequests.get(requestId);
		if (!pending || pending.expiresAt < now) {
			this.pendingRequests.delete(requestId);
			return { outcome: 'unknown-request' };
		}
		if (pending.flowId !== undefined && flowId !== undefined && pending.flowId !== flowId) {
			return { outcome: 'flow-mismatch' };
		}
		this.pendingRequests.delete(requestId);
		return { outcome: 'consumed' };
	}

	/**
	 * Record a response/assertion ID as consumed until its validity window
	 * ends. Returns false when the ID was already recorded.
	 */
	consumeMessageId(id: string, validUntil: number, now = Date.now()): boolean {
		this.evictExpired(now);
		const known = this.consumedIds.get(id);
		if (known !== undefined && known >= now) return false;
		if (this.consumedIds.size >= MAX_CONSUMED_IDS) {
			const oldest = this.consumedIds.keys().next();
			if (!oldest.done) this.consumedIds.delete(oldest.value);
		}
		const cappedExpiry = Math.min(validUntil, now + SAML_CONSUMED_ID_MAX_TTL_MS);
		this.consumedIds.set(id, Math.max(cappedExpiry, now));
		return true;
	}

	/** Drop all retained flow state (used when SAML preferences are reset). */
	clear(): void {
		this.pendingRequests.clear();
		this.consumedIds.clear();
	}

	private evictExpired(now: number): void {
		for (const [requestId, entry] of this.pendingRequests) {
			if (entry.expiresAt < now) this.pendingRequests.delete(requestId);
		}
		for (const [id, expiresAt] of this.consumedIds) {
			if (expiresAt < now) this.consumedIds.delete(id);
		}
	}
}
