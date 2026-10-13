/** MCP tool result helpers shared by every tool module. */
import { ProjectXError } from "./client.js";
import { RiskError } from "./risk.js";

export const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function describeError(e: unknown): string {
  if (e instanceof RiskError) return `Blocked by risk guardrail: ${e.message}`;
  if (e instanceof ProjectXError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return failure(describeError(e));
    }
  };
}

