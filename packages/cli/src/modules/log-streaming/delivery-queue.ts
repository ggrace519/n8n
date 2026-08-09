/**
 * Bounded, serial delivery queue: tasks run one at a time in admission order.
 *
 * Overflow policy: when the queue is at capacity, `enqueue` rejects admission
 * (returns `undefined`) and the caller treats the delivery as failed, leaving
 * the message unconfirmed in the event log — the bus's unsent-retry loop will
 * redeliver it later. We deliberately shed the *newest* work instead of
 * dropping queued (older) deliveries, because unconfirmed messages are
 * recoverable while silently cancelling admitted work is not observable.
 */
export class BoundedDeliveryQueue {
	private tail: Promise<unknown> = Promise.resolve();

	private queuedCount = 0;

	private acceptingWork = true;

	constructor(private readonly maxQueued: number) {}

	/**
	 * Admit a task. Returns the task's result promise, or `undefined` when the
	 * queue is full or draining (admission stopped).
	 */
	enqueue<T>(task: () => Promise<T>): Promise<T> | undefined {
		if (!this.acceptingWork || this.queuedCount >= this.maxQueued) return undefined;
		this.queuedCount++;
		const result = this.tail.then(task);
		// the tail never rejects; task rejections propagate to the caller via `result`
		this.tail = result.then(
			() => {
				this.queuedCount--;
			},
			() => {
				this.queuedCount--;
			},
		);
		return result;
	}

	get size(): number {
		return this.queuedCount;
	}

	/**
	 * Stop admission and wait until every admitted task settles, or until the
	 * timeout elapses — whichever comes first.
	 */
	async drain(timeoutMs: number): Promise<void> {
		this.acceptingWork = false;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		});
		try {
			await Promise.race([
				this.tail.then(
					() => {},
					() => {},
				),
				timeout,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
