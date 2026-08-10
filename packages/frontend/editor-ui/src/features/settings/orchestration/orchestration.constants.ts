/** Base path of the orchestration (multi-main / worker view) REST endpoints (mounted under `/rest`). */
export const ORCHESTRATION_API_ROOT = '/orchestration';

/**
 * How often the worker view asks the backend to request fresh status from all
 * workers. The request is fire-and-forget; replies arrive asynchronously over
 * the push connection.
 */
export const WORKER_STATUS_POLL_INTERVAL = 1000;

/**
 * A worker that has not reported within this window is considered gone and is
 * dropped from the list. Kept comfortably above the poll interval so a single
 * missed reply does not flap a worker out of the view.
 */
export const WORKER_STALE_TIMEOUT = 10_000;
