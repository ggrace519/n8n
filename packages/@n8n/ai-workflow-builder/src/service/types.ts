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
 * A resolved expression the editor evaluated for the user.
 *
 * Structurally mirrors the interface of the same name in `@n8n/api-types`,
 * which the request DTO uses but does not re-export. Kept local rather than
 * pulling in that package for one shape; the controller assigns the DTO value
 * straight into {@link ChatPayload}, so any drift fails `packages/cli`'s
 * typecheck at the call site rather than passing silently.
 */
export interface ExpressionValue {
	expression: string;
	resolvedValue: unknown;
	nodeType?: string;
}

/**
 * A node the user selected or focused, so the builder can prioritise it.
 *
 * Local for the same reason as {@link ExpressionValue}.
 */
export interface SelectedNodeContext {
	/** Display name; look the full node up in `currentWorkflow.nodes`. */
	name: string;
	issues?: Record<string, string[]>;
	incomingConnections: string[];
	outgoingConnections: string[];
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

/**
 * One turn of a builder conversation, as the service receives it.
 *
 * The controller assembles this from `AiBuilderChatRequestDto`; it is not the
 * request body itself. Notably the request's `text` arrives here as `message`.
 */
export interface ChatPayload {
	/** Client-generated message id, echoed back so the UI can match responses. */
	id: string;
	message: string;
	workflowContext: ChatWorkflowContext;
	featureFlags?: {
		pinData?: boolean;
		mergeAskBuild?: boolean;
	};
	/** Workflow version current when the message was sent, for restore. */
	versionId?: string;
	/** `plan` proposes steps for approval first; `build` generates directly. */
	mode?: 'build' | 'plan';
	/**
	 * Opaque value resuming an interrupted run (plan approval, an answered
	 * question, a web-fetch decision). Deliberately untyped — the editor does not
	 * pin an exhaustive schema, so narrowing it here would reject valid clients.
	 */
	resumeData?: unknown;
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
