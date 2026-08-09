import type { SecretsProviderState } from '@n8n/api-types';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

export type { SecretsProviderState };

/**
 * One provider's persisted configuration. Also the shape of a single entry in
 * the legacy `feature.externalSecrets` settings row, which is why it carries
 * the connection intent alongside the provider-specific `settings`.
 */
export interface SecretsProviderSettings<T extends IDataObject = IDataObject> {
	connected: boolean;
	connectedAt: Date | string | null;
	settings: T;
}

/** The decrypted `feature.externalSecrets` settings row, keyed by provider name. */
export type ExternalSecretsSettings = Record<string, SecretsProviderSettings>;

/**
 * A connection to an external secrets store.
 *
 * Subclasses own the vendor conversation; the base class owns the state machine
 * so every provider reports connection progress and failure the same way.
 */
export abstract class SecretsProvider {
	/** Provider type identifier, e.g. `awsSecretsManager`. */
	abstract name: string;

	abstract displayName: string;

	/** Falls back to {@link name} when a provider ships no dedicated icon. */
	icon?: string;

	/** Settings form definition, rendered by the frontend. */
	abstract properties: INodeProperties[];

	state: SecretsProviderState = 'initializing';

	connectedAt: Date | string | null | false = null;

	/**
	 * Why the last connection attempt failed. Surfaced by the connection-test
	 * routes; never contains secret material — providers must not put
	 * credentials in their error messages.
	 */
	connectionError?: string;

	abstract init(settings: SecretsProviderSettings): Promise<void>;

	/**
	 * Establish the connection, recording the outcome in {@link state}.
	 *
	 * Deliberately does not rethrow: a single unreachable store must not abort
	 * start-up for every other provider, and callers decide what a failed
	 * provider means for them by reading `state`.
	 */
	async connect(): Promise<void> {
		this.state = 'connecting';
		this.connectionError = undefined;
		try {
			await this.doConnect();
			this.state = 'connected';
			this.connectedAt = new Date();
		} catch (error) {
			this.state = 'error';
			this.connectionError = error instanceof Error ? error.message : String(error);
		}
	}

	protected abstract doConnect(): Promise<void>;

	abstract disconnect(): Promise<void>;

	/** Refresh the provider's view of the store's secrets. */
	abstract update(): Promise<void>;

	/** `[ok]`, or `[false, reason]` when the store rejected the settings. */
	abstract test(): Promise<[boolean] | [boolean, string]>;

	abstract getSecret(name: string): unknown;

	abstract hasSecret(name: string): boolean;

	abstract getSecretNames(): string[];
}

export type SecretsProviderConstructor = new () => SecretsProvider;
