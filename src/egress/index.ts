/**
 * Egress layer — config-driven per-job network policy for sandbox targets.
 *
 * Each resolver maps a `PlannedJob` to a structural `JobNetwork` ({ allowedHosts,
 * secrets }) the runtime forwards verbatim to the target; the target swaps secret
 * placeholders into outbound headers host-side only. `composeResolvers` unions
 * several resolvers (e.g. the agent resolver in src/agent/egress.ts plus the
 * datasource resolver here) into the single `resolveJobNetwork` the runtime takes.
 *
 * Note: nothing here is wired into the runtime/CLI yet — that assembly is a later
 * step (the agent resolver is the only one currently wired). This barrel just
 * exposes the resolver + compose surface.
 */
export { makeDatasourceEgressResolver, type DatasourceJobNetwork } from "./datasource.ts";
export { composeResolvers, type ComposedJobNetwork } from "./compose.ts";
