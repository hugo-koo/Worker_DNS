/**
 * ObexDNS Pipeline Resolver.
 *
 * Re-exports the modular resolver subsystem from ./resolver for backward compatibility.
 * All core concerns (transports, ECS, ECH, block synthesis, observability) are maintained
 * under ./resolver.
 */
export * from "./resolver/index";
export { pipelineResolver } from "./resolver/index";
