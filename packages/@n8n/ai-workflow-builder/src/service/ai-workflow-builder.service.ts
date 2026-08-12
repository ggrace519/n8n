import type { INodeTypeDescription, IUser, Logger } from 'n8n-workflow';

import { AiBuilderUnavailableError } from './errors';
import type { WebFetchSsrfGuard } from './ssrf-guard';
import type {
	BuilderInstanceCredits,
	ChatPayload,
	ModelFetch,
	OnCreditsUpdated,
	OnTelemetryEvent,
	ResourceLocatorCallbackFactory,
} from './types';
import type { ISessionStorage } from '../session/types';

/** One chunk of a builder reply, as written to the response stream. */
export interface ChatResponsePayload {
	sessionId?: string;
	messages: Array<Record<string, unknown>>;
}

/** One conversation as `/ai/sessions` reports it. */
export interface BuilderSessionSummary {
	sessionId: string;
	messages: Array<Record<string, unknown>>;
	/** ISO timestamp. */
	lastUpdated: string;
	activeVersionCardId?: string | null;
	resumeAfterRestoreMessageId?: string | null;
}

/**
 * Thread key for a conversation. Must stay in step with `parseThreadId` in
 * `WorkflowBuilderSessionRepository`, which is the inverse.
 */
export function buildThreadId(workflowId: string, userId: string, isCodeBuilder = false): string {
	return `workflow-${workflowId}-user-${userId}${isCodeBuilder ? '-code' : ''}`;
}

/**
 * The AI Workflow Builder.
 *
 * **The LLM agent is not implemented in this build.** Everything that can be
 * answered truthfully from session storage alone is answered; everything that
 * would require the agent throws {@link AiBuilderUnavailableError}.
 *
 * The dividing line is fidelity, not convenience. Reading "this workflow has no
 * saved conversation" is a fact the storage layer knows. Rendering a saved
 * conversation is not — stored turns are LangChain messages the agent wrote in
 * its own encoding, and there is no way to map them to the editor's message
 * union without the agent that produced them. Guessing would show the user a
 * plausible but wrong transcript, so those paths fail loudly instead.
 *
 * Constructor arguments are kept rather than dropped: they are the wiring the
 * real agent needs, and preserving them means dropping the agent in does not
 * also mean re-threading twelve dependencies through `packages/cli`.
 */
export class AiWorkflowBuilderService {
	constructor(
		protected nodeTypes: INodeTypeDescription[],
		protected readonly sessionStorage: ISessionStorage,
		/**
		 * Client for n8n's hosted AI assistant service. Opaque here — narrowing it
		 * would mean depending on the SDK for a value this build never calls.
		 */
		protected readonly client: unknown,
		protected readonly logger: Logger,
		protected readonly instanceId: string,
		protected readonly instanceBaseUrl: string,
		protected readonly n8nVersion: string,
		protected readonly onCreditsUpdated: OnCreditsUpdated,
		protected readonly onTelemetryEvent: OnTelemetryEvent,
		protected readonly builtinNodeDefinitionDirs: string[],
		protected readonly resourceLocatorCallbackFactory: ResourceLocatorCallbackFactory,
		protected readonly webFetchSsrfGuard: WebFetchSsrfGuard,
		protected readonly modelFetch: ModelFetch,
	) {}

	/**
	 * Swap in a refreshed node-type catalogue, e.g. after a community package is
	 * installed. Kept live so sessions survive the change.
	 */
	updateNodeTypes(nodeTypes: INodeTypeDescription[]): void {
		this.nodeTypes = nodeTypes;
	}

	/**
	 * @throws {AiBuilderUnavailableError} always — generating a workflow needs the agent.
	 *
	 * Declared as a generator so the failure arrives when the caller starts
	 * iterating, inside the controller's streaming `try`. That is what turns it
	 * into a rendered in-chat error rather than an unhandled rejection after the
	 * response headers have already gone out.
	 */
	// Never yields and never awaits — it only throws. Both are the point.
	// eslint-disable-next-line require-yield, @typescript-eslint/require-await
	async *chat(
		_payload: ChatPayload,
		_user: IUser,
		_abortSignal?: AbortSignal,
	): AsyncGenerator<ChatResponsePayload> {
		throw new AiBuilderUnavailableError('chat');
	}

	/**
	 * List a user's saved conversations for a workflow.
	 *
	 * Returns an empty list when storage holds nothing — a true answer, and the
	 * normal one here, since no agent has ever written a session in this build.
	 *
	 * @throws {AiBuilderUnavailableError} when a session *does* exist (carried
	 * over from an instance that ran the agent), because its turns cannot be
	 * faithfully rendered without it.
	 */
	async getSessions(
		workflowId: string | undefined,
		user: IUser,
		isCodeBuilder?: boolean,
	): Promise<{ sessions: BuilderSessionSummary[] }> {
		if (!workflowId) return { sessions: [] };

		const session = await this.sessionStorage.getSession(
			buildThreadId(workflowId, user.id, isCodeBuilder),
		);
		if (!session || session.messages.length === 0) return { sessions: [] };

		throw new AiBuilderUnavailableError('getSessions (a stored conversation exists)');
	}

	/** Discard a workflow's saved conversation. Unambiguous, so it runs for real. */
	async clearSession(workflowId: string, user: IUser): Promise<void> {
		await this.sessionStorage.deleteSession(buildThreadId(workflowId, user.id));
	}

	/**
	 * Drop every turn after `messageId`, so the user can retry from a point.
	 *
	 * @returns `false` when there is nothing to truncate.
	 * @throws {AiBuilderUnavailableError} when a conversation exists — locating a
	 * turn and reconciling `versionCardId` are agent semantics.
	 */
	async truncateMessagesAfter(
		workflowId: string,
		user: IUser,
		_messageId: string,
		_versionCardId?: string,
	): Promise<boolean> {
		const session = await this.sessionStorage.getSession(buildThreadId(workflowId, user.id));
		if (!session || session.messages.length === 0) return false;

		throw new AiBuilderUnavailableError('truncateMessagesAfter');
	}

	/**
	 * @throws {AiBuilderUnavailableError} always — the balance is held by the
	 * hosted assistant service this build never contacts. Reporting zero credits
	 * would read as "you are out", which is a different and wrong statement.
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async getBuilderInstanceCredits(_user: IUser): Promise<BuilderInstanceCredits> {
		throw new AiBuilderUnavailableError('getBuilderInstanceCredits');
	}
}
