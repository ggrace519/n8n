import type {
	INodeCredentials,
	INodeListSearchResult,
	INodeParameters,
	INodeTypeNameVersion,
} from 'n8n-workflow';

/**
 * Resolves resource-locator / load-options values for a node parameter, scoped
 * to a single user. Mirrors `DynamicNodeParametersService.getResourceLocatorResults`.
 */
export type ResourceLocatorCallback = (
	methodName: string,
	path: string,
	nodeTypeAndVersion: INodeTypeNameVersion,
	currentNodeParameters: INodeParameters,
	credentials?: INodeCredentials,
	filter?: string,
	paginationToken?: string,
) => Promise<INodeListSearchResult>;

/**
 * Builds a {@link ResourceLocatorCallback} bound to a specific user, so the
 * builder can resolve pickers using that user's credentials and context.
 */
export type ResourceLocatorCallbackFactory = (userId: string) => ResourceLocatorCallback;
