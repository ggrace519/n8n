import { BoundedDeliveryQueue } from '../delivery-queue';

describe('BoundedDeliveryQueue', () => {
	it('runs tasks serially in admission order', async () => {
		const queue = new BoundedDeliveryQueue(10);
		const order: number[] = [];
		const first = queue.enqueue(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push(1);
			return 1;
		});
		const second = queue.enqueue(async () => {
			order.push(2);
			return 2;
		});
		await Promise.all([first, second]);
		expect(order).toEqual([1, 2]);
	});

	it('rejects admission when the queue is full', async () => {
		const queue = new BoundedDeliveryQueue(1);
		let release!: () => void;
		const blocker = new Promise<void>((resolve) => (release = resolve));
		const admitted = queue.enqueue(async () => await blocker);
		expect(admitted).toBeDefined();
		expect(queue.enqueue(async () => {})).toBeUndefined();
		release();
		await admitted;
		expect(queue.enqueue(async () => {})).toBeDefined();
	});

	it('propagates task rejections to the caller without breaking the chain', async () => {
		const queue = new BoundedDeliveryQueue(10);
		const failing = queue.enqueue(async () => {
			throw new Error('boom');
		});
		await expect(failing).rejects.toThrow('boom');
		await expect(queue.enqueue(async () => 'next')).resolves.toBe('next');
	});

	it('drain stops admission and waits for in-flight tasks', async () => {
		const queue = new BoundedDeliveryQueue(10);
		let finished = false;
		void queue.enqueue(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			finished = true;
		});
		await queue.drain(1000);
		expect(finished).toBe(true);
		expect(queue.enqueue(async () => {})).toBeUndefined();
	});

	it('drain returns after the timeout even when a task hangs', async () => {
		const queue = new BoundedDeliveryQueue(10);
		void queue.enqueue(async () => await new Promise(() => {})); // never settles
		const start = Date.now();
		await queue.drain(50);
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
