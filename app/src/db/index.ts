import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const baseFetch = neonConfig.fetchFunction ?? fetch;
/**
 * Retries connection-level failures and stalls for read-only queries only.
 * Writes are never retried here, because a request that failed after being sent could otherwise run twice.
 */
neonConfig.fetchFunction = async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : "";
  const readOnly = /"query"s*:s*"s*(select|with)/i.test(body);
  if (!readOnly) return baseFetch(input, init);
  // Reads only: a stalled connection is abandoned after 8 s and retried, so one bad connection cannot hang a page.
  for (let attempt = 0; ; attempt++) {
    try {
      return await baseFetch(input, { ...init, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
};

export const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
export { schema };
