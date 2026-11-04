import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const url = readFileSync(".env.staging", "utf8").match(/^DATABASE_URL=(.*)$/m)![1].trim();
// Hard guard: refuse to touch the production endpoint.
if (url.includes("ep-long-fire")) throw new Error("e2e must never run against the production database");
const sql = neon(url);

/** Test-harness query helper. Retries transient network errors only (the app itself is not retried). */
export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try { return (await sql.query(text, params)) as T[]; }
    catch (e) {
      last = e;
      if (!/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket/i.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
