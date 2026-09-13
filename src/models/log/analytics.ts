/**
 * ObexDNS Log Analytics Model.
 *
 * Re-exports the modular log analytics subsystem from ./analytics for backward compatibility.
 * All domain-specific analytics (traffic, domains, clients, destinations) are maintained under ./analytics.
 */
export * from "./analytics/index";
export { LogAnalyticsModel } from "./analytics/index";
