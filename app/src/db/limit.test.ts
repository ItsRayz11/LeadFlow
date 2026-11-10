import { describe, expect, it } from "vitest";
import { createLimiter } from "@/db/limit";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createLimiter", () => {
  it("never runs more than the cap at once, and finishes everything", async () => {
    const run = createLimiter(4);
    let now = 0, peak = 0;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => run(async () => {
      now++; peak = Math.max(peak, now);
      await tick(2 + (i % 3));
      now--;
      return i;
    })));
    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("starts waiting tasks in the order they arrived", async () => {
    const run = createLimiter(1);
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => run(async () => { await tick(1); order.push(i); })));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("frees the slot when a task fails, so one error cannot stall the rest", async () => {
    const run = createLimiter(1);
    const bad = run(async () => { throw new Error("boom"); });
    const good = run(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
    await expect(run(async () => "again")).resolves.toBe("again"); // and nothing leaked
  });
});
