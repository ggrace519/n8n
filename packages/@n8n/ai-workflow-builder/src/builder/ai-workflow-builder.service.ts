import type { Logger } from '@n8n/backend-common';
import type { AiAssistantClient, AiAssistantSDK } from '@n8n_io/ai-assistant-sdk';
import {
	UnexpectedError,
	type INodeTypeDescription,
	type ITelemetryTrackProperties,
	type IUser,
} from 'n8n-workflow';

import type { BuilderChatResponse, BuilderSessionSummary, ChatPayload } from './chat-payload';
import type { ResourceLocatorCallbackFactory } from './resource-locator';
import type { WebFetchSsrfGuard } from './ssrf-guard';
import type { ISessionStorage } from '../session';

/**
 * The AI workflow builder agent (layer 4).
 *
 * This is a deliberate **fail-loud placeholder**. The licensed builder agent was
 * removed in the de-fork; its fair-code replacement — an LLM agent driving the
 * workflow SDK — has not yet been designed and built. The surrounding surface
 * (tool descriptors, parse/validate, session storage; layers 1–3) is real, and
 * this class preserves the exact construction and method contract the CLI wrapper
 * depends on, so the codebase type-checks and boots.
 *
 * Every operation throws. It is never a silent stub: reaching any method means
 * `feat:aiBuilder` was licensed against a build without the agent, and that must
 * surface as an error rather than pretend to work. Replace the bodies (not the
 * signatures) when the clean-room agent lands.
 */
export class AiWorkflowBuilderService {
	constructor(
		// The parameters are the injected collaborators the real agent will use.
		// They are retained (typed, unused) to pin the construction contract for
		// the clean-room implementation; the CLI passes them positionally.
		_nodeTypeDescriptions: INodeTypeDescription[],
		_sessionStorage: ISessionStorage,
		_aiAssistantClient: AiAssistantClient | undefined,
		_logger: Logger,
		_instanceId: string,
		_instanceBaseUrl: string,
		_n8nVersion: string,
		_onCreditsUpdated: (userId: string, creditsQuota: number, creditsClaimed: number) => void,
		_onTelemetryEvent: (event: string, properties: ITelemetryTrackProperties) => void,
		_builtinNodeDefinitionDirs: string[],
		_resourceLocatorCallbackFactory: ResourceLocatorCallbackFactory,
		_webFetchSsrfGuard: WebFetchSsrfGuard,
		_modelFetch: typeof fetch,
	) {}

	/** Refresh the node-type catalogue on the live agent (e.g. after a package install). */
	updateNodeTypes(_nodeTypeDescriptions: INodeTypeDescription[]): void {
		this.fail();
	}

	/** Stream a builder turn. */
	chat(
		_payload: ChatPayload,
		_user: IUser,
		_abortSignal?: AbortSignal,
	): AsyncGenerator<BuilderChatResponse> {
		return this.fail();
	}

	/** Replay stored builder sessions for a workflow. */
	async getSessions(
		_workflowId: string | undefined,
		_user: IUser,
		_isCodeBuilder?: boolean,
	): Promise<{ sessions: BuilderSessionSummary[] }> {
		await Promise.resolve();
		return this.fail();
	}

	/** Report the instance's remaining builder credits. */
	async getBuilderInstanceCredits(
		_user: IUser,
	): Promise<AiAssistantSDK.BuilderInstanceCreditsResponse> {
		await Promise.resolve();
		return this.fail();
	}

	/** Clear the builder session for a workflow. */
	async clearSession(_workflowId: string, _user: IUser): Promise<void> {
		await Promise.resolve();
		this.fail();
	}

	/** Truncate a builder session's history after a given message. */
	async truncateMessagesAfter(
		_workflowId: string,
		_user: IUser,
		_messageId: string,
		_versionCardId?: string,
	): Promise<boolean> {
		await Promise.resolve();
		return this.fail();
	}

	private fail(): never {
		throw new UnexpectedError(
			'The AI workflow builder agent is not available in this build. Its fair-code ' +
				'replacement (@n8n/ai-workflow-builder layer 4) has not been implemented yet, so ' +
				'`feat:aiBuilder` builder requests cannot be served. This is an intentional ' +
				'fail-loud placeholder, never a silent stub.',
		);
	}
}
