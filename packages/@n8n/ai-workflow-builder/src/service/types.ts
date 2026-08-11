import type { AiBuilderChatRequestDto, SelectedNodeContext } from '@n8n/api-types';
import type {
	INodeCredentials,
	INodeListSearchResult,
	INodeParameters,
	INodeTypeNameVersion,
	IRunExecutionData,
	ITelemetryTrackProperties,
	IWorkflowBase,
	NodeExecutionSchema,
} from 'n8n-workflow';

/**
 * A node the user selected or focused, so the builder can prioritise it.
 *
 * Re-exported from `@n8n/api-types` rather than redeclared: the request DTO
 * exports this shape, so a local copy would be a second definition free to
 * drift from the wire contract it is supposed to mirror.
 */
export type { SelectedNodeContext };

/**
 * A resolved expression the editor evaluated for the user.
 *
 * Kept local because — unlike {@link SelectedNodeContext} — `@n8n/api-types`
 * declares this interface but does **not** re-export it from the package root.
 * The controller assigns the DTO value straight into {@link ChatPayload}, so
 * any drift fails `packages/cli`'s typecheck at the call site rather than
 * passing silently.
 */
export interface ExpressionValue {
	expression: string;
	resolvedValue: unknown;
	nodeType?: string;
}

/**
 * What the editor knows about the workflow when the user sends a message.
 *
 * Every field is optional: the panel can be opened on an empty canvas, before
 * any execution, with nothing selected.
 */
export interface ChatWorkflowContext {
	currentWorkflow?: Partial<IWorkflowBase>;
	executionData?: IRunExecutionData['resultData'];
	executionSchema?: NodeExecutionSchema[];
	expressionValues?: Record<string, ExpressionValue[]>;
	/** Execution values were withheld (data-privacy setting), not merely absent. */
	valuesExcluded?: boolean;
	pinnedNodes?: string[];
	selectedNodes?: SelectedNodeContext[];
}

/** The validated wire payload the `/ai/build` controller receives. */
type BuilderRequestPayload = AiBuilderChatRequestDto['payload'];

/**
 * One turn of a builder conversation, as the service receives it.
 *
 * The controller assembles this from `AiBuilderChatRequestDto`; it is not the
 * request body itself. Notably the request's `text` arrives here as `message`,
 * and transport-only fields (`role`, `type`) are dropped.
 *
 * Every field is **derived from the DTO** rather than restated, so the wire
 * contract and this shape cannot drift apart: a change to the request schema
 * either flows through here or fails the build.
 */
export interface ChatPayload {
	/** Client-generated message id, echoed back so the UI can match responses. */
	id: BuilderRequestPayload['id'];
	/** The user's message text — the DTO's `text`, renamed. */
	message: BuilderRequestPayload['text'];
	workflowContext: ChatWorkflowContext;
	featureFlags?: BuilderRequestPayload['featureFlags'];
	/** Workflow version current when the message was sent, for restore. */
	versionId?: BuilderRequestPayload['versionId'];
	/** `plan` proposes steps for approval first; `build` generates directly. */
	mode?: BuilderRequestPayload['mode'];
	/**
	 * Opaque value resuming an interrupted run (plan approval, an answered
	 * question, a web-fetch decision). Deliberately untyped — the editor does not
	 * pin an exhaustive schema, so narrowing it here would reject valid clients.
	 */
	resumeData?: BuilderRequestPayload['resumeData'];
}

/**
 * Builds a resource-locator resolver bound to one user.
 *
 * Curried by user because listing a node's selectable resources hits a third-
 * party API with that user's stored credentials — the identity has to be fixed
 * when the callback is created, not read from ambient state when it runs.
 */
export type ResourceLocatorCallbackFactory = (
	userId: string,
) => (
	methodName: string,
	path: string,
	nodeTypeAndVersion: INodeTypeNameVersion,
	currentNodeParameters: INodeParameters,
	credentials?: INodeCredentials,
	filter?: string,
	paginationToken?: string,
) => Promise<INodeListSearchResult>;

/** Push a credit-balance change to the user's open editor tabs. */
export type OnCreditsUpdated = (
	userId: string,
	creditsQuota: number,
	creditsClaimed: number,
) => void;

/** Forward a builder telemetry event to the instance's telemetry pipeline. */
export type OnTelemetryEvent = (event: string, properties: ITelemetryTrackProperties) => void;

/** Drop-in replacement for global `fetch`, pre-configured with proxy and timeouts. */
export type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Instance-level credit allowance for the builder. */
export interface BuilderInstanceCredits {
	creditsQuota: number;
	creditsClaimed: number;
}
