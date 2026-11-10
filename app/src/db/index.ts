import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { createLimiter } from "./limit";
import * as schema from "./schema";

const baseFetch = neonConfig.fetchFunction ?? fetch;
/**
 * A page can ask for dozens of queries at once. Opening them all together overloads weak or distant links (connections time out and the
 * page fails) and puts needless pressure on a small database. At most this many are in flight per server instance; the rest queue.
 * In the same region a query takes a few milliseconds, so the cap costs almost nothing there.
 */
const MAX_IN_FLIGHT = 10;
const limit = createLimiter(MAX_IN_FLIGHT);

/**
 * Retries connection-level failures and stalls for read-only queries only.
 * Writes are never retried here, because a request that failed after being sent could otherwise run twice.
 */
neonConfig.fetchFunction = async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : "";
  const readOnly = /"query"\s*:\s*"\s*(select|with)/i.test(body);
  if (!readOnly) return limit(() => baseFetch(input, init));
  // Reads only: a stalled connection is abandoned after 8 s and retried, so one bad connection cannot hang a page.
  // The timer starts when the request actually leaves, not while it waits in the queue.
  for (let attempt = 0; ; attempt++) {
    try {
      return await limit(() => baseFetch(input, { ...init, signal: AbortSignal.timeout(8000) }));
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
};

export const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
export { schema };
