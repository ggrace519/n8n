import type { RunningJobSummary } from '@n8n/api-types';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { Push } from '@/push';

import type { JobProcessor } from '../job-processor';
import type { Publisher } from '../pubsub/publisher.service';
import { WorkerStatusService } from '../worker-status.service';

describe('WorkerStatusService', () => {
	const hostId = 'worker-abc';

	let jobProcessor: ReturnType<typeof mock<JobProcessor>>;
	let publisher: ReturnType<typeof mock<Publisher>>;
	let service: WorkerStatusService;

	beforeEach(() => {
		jobProcessor = mock<JobProcessor>();
		jobProcessor.getRunningJobsSummary.mockReturnValue([]);
		publisher = mock<Publisher>();

		service = new WorkerStatusService(
			jobProcessor,
			mock<InstanceSettings>({ hostId, isDocker: false }),
			publisher,
			mock<Push>(),
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('requestWorkerStatus', () => {
		it('should publish a get-worker-status command carrying the requesting user', async () => {
			await service.requestWorkerStatus('user-123');

			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'get-worker-status',
				payload: { requestingUserId: 'user-123' },
			});
		});

		it('should propagate a publish failure to the caller', async () => {
			publisher.publishCommand.mockRejectedValue(new Error('Redis unavailable'));

			await expect(service.requestWorkerStatus('user-123')).rejects.toThrow('Redis unavailable');
		});
	});

	describe('handleWorkerStatusRequest', () => {
		it('should answer with a status snapshot identifying this worker', async () => {
			const runningJobsSummary: RunningJobSummary[] = [
				{
					executionId: '1',
					workflowId: 'wf-1',
					workflowName: 'My workflow',
					mode: 'trigger',
					startedAt: new Date('2026-01-01T00:00:00.000Z'),
					status: 'running',
				},
			];
			jobProcessor.getRunningJobsSummary.mockReturnValue(runningJobsSummary);

			await service.handleWorkerStatusRequest({ requestingUserId: 'user-123' });

			expect(publisher.publishWorkerResponse).toHaveBeenCalledTimes(1);

			const [message] = publisher.publishWorkerResponse.mock.calls[0];

			expect(message.senderId).toBe(hostId);
			expect(message.response).toBe('response-to-get-worker-status');
			expect(message.payload).toMatchObject({
				senderId: hostId,
				requestingUserId: 'user-123',
				runningJobsSummary,
				isInContainer: false,
			});
		});

		it('should report every field the worker-status contract requires', async () => {
			await service.handleWorkerStatusRequest({ requestingUserId: 'user-123' });

			const [message] = publisher.publishWorkerResponse.mock.calls[0];
			const { payload } = message;

			expect(Object.keys(payload).sort()).toEqual(
				[
					'arch',
					'cpus',
					'freeMem',
					'host',
					'hostname',
					'interfaces',
					'isInContainer',
					'loadAvg',
					'platform',
					'process',
					'requestingUserId',
					'runningJobsSummary',
					'senderId',
					'totalMem',
					'uptime',
					'version',
				].sort(),
			);

			expect(typeof payload.cpus).toBe('string');
			expect(payload.process.memory.rss).toBeGreaterThan(0);
			expect(payload.host.memory.total).toBe(payload.totalMem);
			expect(payload.host.memory.free).toBe(payload.freeMem);
			expect(Array.isArray(payload.loadAvg)).toBe(true);
		});

		it('should report a stable, deterministic interface list', async () => {
			await service.handleWorkerStatusRequest({ requestingUserId: 'user-123' });
			await service.handleWorkerStatusRequest({ requestingUserId: 'user-123' });

			const [first] = publisher.publishWorkerResponse.mock.calls[0];
			const [second] = publisher.publishWorkerResponse.mock.calls[1];

			expect(first.payload.interfaces).toEqual(second.payload.interfaces);

			for (const iface of first.payload.interfaces) {
				expect(['IPv4', 'IPv6']).toContain(iface.family);
				expect(typeof iface.address).toBe('string');
				expect(typeof iface.internal).toBe('boolean');
			}
		});

		it('should report unknown memory metrics as 0 instead of failing the request', async () => {
			const constrainedMemory = vi.spyOn(process, 'constrainedMemory').mockImplementation(() => {
				throw new Error('not supported on this platform');
			});
			const availableMemory = vi.spyOn(process, 'availableMemory').mockReturnValue(Number.NaN);

			await service.handleWorkerStatusRequest({ requestingUserId: 'user-123' });

			const [message] = publisher.publishWorkerResponse.mock.calls[0];

			expect(message.payload.process.memory.constraint).toBe(0);
			expect(message.payload.process.memory.available).toBe(0);

			constrainedMemory.mockRestore();
			availableMemory.mockRestore();
		});

		it('should propagate a publish failure so it is not silently swallowed', async () => {
			publisher.publishWorkerResponse.mockRejectedValue(new Error('Redis unavailable'));

			await expect(
				service.handleWorkerStatusRequest({ requestingUserId: 'user-123' }),
			).rejects.toThrow('Redis unavailable');
		});
	});
});
