/**
 * Browser-safe entry point: the type contract and the Redis constants only.
 *
 * Config loading touches node:fs and lives behind `@argus/shared/config`.
 */
export * from "./events.js";
