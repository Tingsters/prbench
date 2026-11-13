import { expect, test } from "bun:test";
import { runPool, type PoolJob } from "../src/run/pool.ts";

const job = (
  id: string,
  run: () => Promise<void>,
  deps: string[] = [],
  priority = 0,
): PoolJob => ({ id, label: id, deps, priority, run });

test("never exceeds the limit and actually overlaps", async () => {
  let running = 0,
    peak = 0;
  const work = () => async () => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(20);
    running--;
  };
  await runPool(
    Array.from({ length: 10 }, (_, i) => job(`j${i}`, work())),
    { limit: 3 },
  );
  expect(peak).toBe(3);
});

test("a job starts only after its dependencies, and priority orders ready jobs", async () => {
  const order: string[] = [];
  const log =
    (id: string, ms = 5) =>
    async () => {
      await Bun.sleep(ms);
      order.push(id);
    };
  await runPool(
    [
      job("w1", log("w1", 30)),
      job("w2", log("w2", 5)),
      job("w3", log("w3", 5)),
      // Ready once w1 and w2 finish; outranks the remaining writer.
      job("judge", log("judge"), ["w1", "w2"], 100),
      job("w4", log("w4", 5)),
    ],
    { limit: 2 },
  );
  expect(order.indexOf("judge")).toBeGreaterThan(order.indexOf("w1"));
  expect(order.indexOf("judge")).toBeGreaterThan(order.indexOf("w2"));
  expect(order).toHaveLength(5);
});

test("limit 1 runs jobs in priority order exactly", async () => {
  const order: string[] = [];
  const log = (id: string) => async () => void order.push(id);
  await runPool(
    [
      job("a", log("a"), [], -0),
      job("b", log("b"), [], -1),
      job("c", log("c"), ["a"], -2),
      job("d", log("d"), [], -3),
    ],
    { limit: 1 },
  );
  expect(order).toEqual(["a", "b", "c", "d"]);
});

test("after a failure nothing new starts, running jobs finish, the error surfaces", async () => {
  const finished: string[] = [];
  const slow = (id: string) => async () => {
    await Bun.sleep(40);
    finished.push(id);
  };
  await expect(
    runPool(
      [
        job("slow", slow("slow")),
        job("bad", async () => {
          await Bun.sleep(5);
          throw new Error("boom");
        }),
        job("later", slow("later")),
      ],
      { limit: 2 },
    ),
  ).rejects.toThrow("boom");
  expect(finished).toEqual(["slow"]);
});

test("cancellation stops dispatch", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const run = (id: string) => async () => {
    started.push(id);
    controller.abort();
    await Bun.sleep(5);
  };
  await expect(
    runPool([job("a", run("a")), job("b", run("b"))], {
      limit: 1,
      signal: controller.signal,
    }),
  ).rejects.toThrow(/cancelled/);
  expect(started).toEqual(["a"]);
});

test("rejects unknown dependencies and duplicate ids", async () => {
  await expect(
    runPool([job("a", async () => {}, ["missing"])], { limit: 1 }),
  ).rejects.toThrow(/unknown/);
  await expect(
    runPool([job("a", async () => {}), job("a", async () => {})], {
      limit: 1,
    }),
  ).rejects.toThrow(/Duplicate/);
});
