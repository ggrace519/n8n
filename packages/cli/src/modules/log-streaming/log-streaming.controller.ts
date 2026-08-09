import {
	CreateDestinationDto,
	DeleteDestinationQueryDto,
	GetDestinationQueryDto,
	TestDestinationQueryDto,
} from '@n8n/api-types';
import { OutboundHttp } from '@n8n/backend-network';
import { InstanceSettingsLoaderConfig } from '@n8n/config';
import type { AuthenticatedRequest } from '@n8n/db';
import { Delete, Get, GlobalScope, Licensed, Post, Query, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import type { INodeCredentials, MessageEventBusDestinationOptions } from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';
import { z } from 'zod';

import { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { createMessageEventBusDestination } from './create-message-event-bus-destination';
import { LogStreamingDestinationService } from './log-streaming-destination.service';
import { validateDestinationCredentials } from './validate-destination-credentials';

// The DTO leaves `credentials` loosely typed; re-validate it into the
// credential-reference shape the destinations expect.
const credentialsSchema = z
	.record(
		z.object({
			id: z.string().nullable(),
			name: z.string(),
			__aiGatewayManaged: z.boolean().optional(),
		}),
	)
	.optional();

function parseCredentials(credentials: unknown): INodeCredentials {
	return credentialsSchema.parse(credentials ?? {}) ?? {};
}

/** DTO payload → canonical internal destination options. */
function toDestinationOptions(
	data: z.infer<typeof CreateDestinationDto>,
): MessageEventBusDestinationOptions {
	const { __type, credentials, ...rest } = data;
	switch (__type) {
		case '$$MessageEventBusDestinationWebhook':
			return {
				...rest,
				__type: MessageEventBusDestinationTypeNames.webhook,
				credentials: parseCredentials(credentials),
			};
		case '$$MessageEventBusDestinationSentry':
			return {
				...rest,
				__type: MessageEventBusDestinationTypeNames.sentry,
				credentials: parseCredentials(credentials),
			};
		case '$$MessageEventBusDestinationSyslog':
			return {
				...rest,
				__type: MessageEventBusDestinationTypeNames.syslog,
				credentials: parseCredentials(credentials),
			};
	}
}

@RestController('/eventbus')
export class LogStreamingController {
	constructor(
		private readonly destinationService: LogStreamingDestinationService,
		private readonly eventBus: MessageEventBus,
		private readonly outboundHttp: OutboundHttp,
		private readonly instanceSettingsLoaderConfig: InstanceSettingsLoaderConfig,
		private readonly credentialsFinderService: CredentialsFinderService,
	) {}

	private assertNotManagedByEnv() {
		if (this.instanceSettingsLoaderConfig.logStreamingManagedByEnv) {
			throw new ForbiddenError(
				'Log streaming destinations are managed via environment variables and cannot be modified through the API',
			);
		}
	}

	@Get('/destination')
	@Licensed('feat:logStreaming')
	@GlobalScope('logStreaming:manage')
	async getDestination(
		_req: Request,
		_res: Response,
		@Query query: GetDestinationQueryDto,
	): Promise<MessageEventBusDestinationOptions[]> {
		return await this.destinationService.findDestination(query.id);
	}

	@Post('/destination')
	@Licensed('feat:logStreaming')
	@GlobalScope('logStreaming:manage')
	async createDestination(req: AuthenticatedRequest): Promise<MessageEventBusDestinationOptions> {
		this.assertNotManagedByEnv();

		const parseResult = CreateDestinationDto.safeParse(req.body);
		if (!parseResult.success) {
			throw new BadRequestError(parseResult.error.errors[0].message);
		}

		// a repeated save must not overwrite stored secrets with the redaction
		// placeholder that read responses contain
		const options = this.destinationService.restoreRedactedSecrets(
			toDestinationOptions(parseResult.data),
		);

		// a credential reference is persisted only after the requesting user's
		// access to it (and its type) has been verified
		const validated = await validateDestinationCredentials(
			options,
			req.user,
			this.credentialsFinderService,
		);

		const destination = createMessageEventBusDestination(
			this.eventBus,
			this.outboundHttp,
			validated,
		);
		const result = await this.destinationService.addDestination(destination);
		return result.serialize();
	}

	@Delete('/destination')
	@Licensed('feat:logStreaming')
	@GlobalScope('logStreaming:manage')
	async deleteDestination(
		_req: Request,
		_res: Response,
		@Query query: DeleteDestinationQueryDto,
	): Promise<{ success: boolean }> {
		this.assertNotManagedByEnv();
		await this.destinationService.removeDestination(query.id);
		return { success: true };
	}

	@Get('/testmessage')
	@Licensed('feat:logStreaming')
	@GlobalScope('logStreaming:manage')
	async sendTestMessage(
		_req: Request,
		_res: Response,
		@Query query: TestDestinationQueryDto,
	): Promise<boolean> {
		// an unknown or unreachable destination is a failed test, not an error
		try {
			return await this.destinationService.testDestination(query.id);
		} catch {
			return false;
		}
	}
}
