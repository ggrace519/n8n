import type { WorkerStatus } from '@n8n/api-types';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import os from 'node:os';

import { N8N_VERSION } from '@/constants';
import { Push } from '@/push';

import { JobProcessor } from './job-processor';
import type { PubSubCommandMap } from './pubsub/pubsub.event-map';
import { Publisher } from './pubsub/publisher.service';

/** Payload a worker sends back, i.e. its status plus the user who asked for it. */
type WorkerStatusResponse = WorkerStatus & { requestingUserId: string };

/**
 * Collects and distributes worker status for the worker-view UI.
 *
 * The flow is fire-and-forget in both directions: a main publishes a request on
 * the command channel, every worker answers independently on the worker-response
 * channel, and every main pushes the answers to the requesting user's browser if
 * that user is connected to it. There is no correlation ID, response deadline,
 * worker enumeration or "all responses received" signal.
 */
@Service()
export class WorkerStatusService {
	constructor(
		private readonly jobProcessor: JobProcessor,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
		private readonly push: Push,
	) {}

	// #region Main side

	/**
	 * Ask every worker to report its status. Returns nothing — answers arrive
	 * asynchronously as push messages. A publish failure rejects and surfaces
	 * through the controller.
	 */
	async requestWorkerStatus(requestingUserId: string) {
		await this.publisher.publishCommand({
			command: 'get-worker-status',
			payload: { requestingUserId },
		});
	}

	/**
	 * Forward one worker's status to the user who requested it.
	 *
	 * Every main receives every worker response; only the main holding that user's
	 * connection actually delivers anything.
	 */
	@OnPubSubEvent('response-to-get-worker-status', { instanceType: 'main' })
	handleWorkerStatusResponse(response: WorkerStatusResponse): void {
		// `requestingUserId` is our routing field, not part of the worker's status.
		// The push payload is typed as a plain `WorkerStatus`, so strip it here
		// rather than echoing an internal id back into the browser.
		const { requestingUserId, ...status } = response;

		this.push.sendToUsers(
			{
				type: 'sendWorkerStatusMessage',
				data: {
					workerId: status.senderId,
					status,
				},
			},
			[requestingUserId],
		);
	}

	// #endregion

	// #region Worker side

	/** Answer a status request with a single snapshot of this worker. */
	@OnPubSubEvent('get-worker-status', { instanceType: 'worker' })
	async handleWorkerStatusRequest({
		requestingUserId,
	}: PubSubCommandMap['get-worker-status']): Promise<void> {
		await this.publisher.publishWorkerResponse({
			senderId: this.instanceSettings.hostId,
			response: 'response-to-get-worker-status',
			payload: { ...this.collectStatus(), requestingUserId },
		});
	}

	/** Take one consistent snapshot of this worker's process and host. */
	private collectStatus(): WorkerStatus {
		const processMemory = process.memoryUsage();
		const freeMem = os.freemem();
		const totalMem = os.totalmem();
		const uptime = os.uptime();

		return {
			senderId: this.instanceSettings.hostId,
			runningJobsSummary: this.jobProcessor.getRunningJobsSummary(),
			isInContainer: this.instanceSettings.isDocker,
			process: {
				memory: {
					available: this.readMemoryMetric(() => process.availableMemory()),
					constraint: this.readMemoryMetric(() => process.constrainedMemory()),
					rss: processMemory.rss,
					heapTotal: processMemory.heapTotal,
					heapUsed: processMemory.heapUsed,
				},
				uptime: process.uptime(),
			},
			host: { memory: { total: totalMem, free: freeMem } },
			freeMem,
			totalMem,
			uptime,
			loadAvg: os.loadavg(),
			cpus: this.describeCpus(),
			arch: os.arch(),
			platform: os.platform(),
			hostname: os.hostname(),
			interfaces: this.describeInterfaces(),
			version: N8N_VERSION,
		};
	}

	/**
	 * Container-aware memory APIs report 0 or throw depending on platform and
	 * cgroup availability, so treat anything non-finite as "unknown" (0) rather
	 * than letting a status request fail over a diagnostic field.
	 */
	private readMemoryMetric(read: () => number): number {
		try {
			const value = read();
			return Number.isFinite(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	private describeCpus(): string {
		const cpus = os.cpus();

		if (cpus.length === 0) return 'unknown';

		const { model, speed } = cpus[0];

		return `${cpus.length}x ${model.trim()} - ${speed}MHz`;
	}

	/** Flatten the per-name interface map into a stable, name-sorted list. */
	private describeInterfaces(): WorkerStatus['interfaces'] {
		const interfaces = os.networkInterfaces();
		const flattened: WorkerStatus['interfaces'] = [];

		for (const name of Object.keys(interfaces).sort()) {
			for (const { family, address, internal } of interfaces[name] ?? []) {
				flattened.push({ family: family === 'IPv6' ? 'IPv6' : 'IPv4', address, internal });
			}
		}

		return flattened;
	}

	// #endregion
}
