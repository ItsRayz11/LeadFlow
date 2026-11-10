/**
 * Runs at most `max` async tasks at once; the rest wait their turn in order.
 * A finished task hands its slot straight to the next waiting one, so the cap is never exceeded, even for an instant.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes to the next waiter
      else active--;
    }
  };
}
