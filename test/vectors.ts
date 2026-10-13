/**
 * Golden order-flow vectors: the runner. A vector (vectors/*.json, schema in
 * docs/ORDER-FLOW-DESIGN.md) is a list of steps on one receive clock: market-hub
 * pushes in the hub's own payload form (GatewayTrade, GatewayDepth,
 * GatewayQuote), connection events, maintenance passes, and MCP tool calls
 * with the exact result today's code returns. `runVector` replays the steps
 * through the real FlowFeed and MCP server (fake hub, fake clock, fake REST)
 * and returns each call's result.
 */
import { FlowFeed } from "../src/flowfeed.js";
import type { FeedKind } from "../src/realtime.js";
import { OK, fakeClock, fakeFlowHub, setup } from "./helpers.js";

export const VECTOR_SCHEMA = "projectx-orderflow-vector/1";

export type VectorStep =
  | { at: number; hub: "trade" | "depth" | "quote"; contractId: string; payload: unknown }
  | { at: number; hub: "down" }
  | { at: number; hub: "resubscribed"; kind: FeedKind; contractId: string }
  | { at: number; tick: true }
  /** What History/retrieveBars returns to get_bars calls from this step on. */
  | { at: number; restBars: Array<Record<string, unknown> & { t: string }> }
  | { at: number; call: { tool: string; args: Record<string, unknown> }; expect?: unknown };

export interface Vector {
  schema: typeof VECTOR_SCHEMA;
  name: string;
  description: string;
  /** Server environment (PROJECTX_FLOW_LARGE_PRINT and the like). */
  env: Record<string, string>;
  /** Tick size the contract lookup returns (footprint imbalance, spread). */
  tickSize: number | null;
  steps: VectorStep[];
}

/** Replay a vector; returns the result of every call step, in order. */
export async function runVector(v: Vector): Promise<unknown[]> {
  if (v.schema !== VECTOR_SCHEMA) throw new Error(`unknown vector schema ${String(v.schema)}`);
  const hub = fakeFlowHub();
  const clock = fakeClock(v.steps[0]?.at ?? 0);
  const flow = new FlowFeed({ hub, now: clock.now, ticks: { get: async () => v.tickSize }, warn: () => {}, timers: { every: () => 1, cancel: () => {} } });
  let restBars: unknown[] = [];
  const s = await setup({ clock, env: v.env, deps: { flow }, routes: { "/api/History/retrieveBars": () => ({ ...OK, bars: restBars }) } });
  const results: unknown[] = [];
  for (const step of v.steps) {
    if (step.at < clock.t) throw new Error(`${v.name}: step at ${step.at} goes back in time`);
    clock.t = step.at;
    if ("call" in step) {
      const r = await s.call(step.call.tool, step.call.args);
      if (r.isError) throw new Error(`${v.name}: ${step.call.tool} failed: ${r.text}`);
      results.push(r.data);
    } else if ("tick" in step) await flow.tick();
    else if ("restBars" in step) restBars = step.restBars;
    else if (step.hub === "down") hub.down();
    else if (step.hub === "resubscribed") hub.resubscribed(step.kind, step.contractId);
    else if (step.hub === "quote") hub.quote(step.contractId, step.payload as Record<string, unknown>);
    else hub[step.hub](step.contractId, step.payload);
  }
  return results;
}

/** The expected results stored in a vector's call steps, in order. */
export const expectedResults = (v: Vector) => v.steps.filter((s): s is Extract<VectorStep, { call: unknown }> => "call" in s).map((s) => s.expect);
