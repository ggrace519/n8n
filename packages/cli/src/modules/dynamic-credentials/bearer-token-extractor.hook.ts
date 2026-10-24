import {
	ContextEstablishmentHook,
	ContextEstablishmentOptions,
	ContextEstablishmentResult,
	HookDescription,
	IContextEstablishmentHook,
} from '@n8n/decorators';
import type { INodeExecutionData } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { EXTERNAL_IDENTITY_SOURCE } from './credential-resolvers/identifiers/oauth2-userinfo-identifier';

export const BEARER_TOKEN_EXTRACTOR_NAME = 'BearerTokenExtractor';

const WEBHOOK_NODE_TYPE = 'n8n-nodes-base.webhook';

/**
 * Takes the caller's `Authorization: Bearer <token>` from a webhook trigger and
 * makes it the execution's end-user identity, so a non-n8n credential resolver
 * can resolve that user's credentials for this run. The header is removed from
 * the trigger item: the token is carried, encrypted, only in the execution
 * context, never in execution data.
 */
@ContextEstablishmentHook()
export class BearerTokenExtractor implements IContextEstablishmentHook {
	hookDescription: HookDescription = {
		name: BEARER_TOKEN_EXTRACTOR_NAME,
		displayName: 'Bearer Token Extractor',
		options: [],
	};

	isApplicableToTriggerNode(nodeType: string): boolean {
		return nodeType === WEBHOOK_NODE_TYPE;
	}

	async execute(options: ContextEstablishmentOptions): Promise<ContextEstablishmentResult> {
		const items = options.triggerItems ?? [];
		const authorization = readAuthorizationHeader(items[0]);
		const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
		if (!match) {
			throw new UserError('This webhook needs an "Authorization: Bearer <token>" header');
		}

		return {
			triggerItems: items.map(withoutAuthorizationHeader),
			contextUpdate: {
				credentials: {
					version: 1,
					identity: `Bearer ${match[1]}`,
					metadata: { source: EXTERNAL_IDENTITY_SOURCE },
				},
			},
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headersOf(item: INodeExecutionData | undefined): Record<string, unknown> | undefined {
	const headers = item?.json?.headers;
	return isRecord(headers) ? headers : undefined;
}

function readAuthorizationHeader(item: INodeExecutionData | undefined): string | undefined {
	const value = headersOf(item)?.authorization;
	return typeof value === 'string' ? value : undefined;
}

function withoutAuthorizationHeader(item: INodeExecutionData): INodeExecutionData {
	const headers = headersOf(item);
	if (!headers || !('authorization' in headers)) return item;
	const { authorization: _, ...rest } = headers;
	return { ...item, json: { ...item.json, headers: rest } };
}
