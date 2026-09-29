import { setTimeout as delay } from "node:timers/promises";

export const scanRequestIntervalMs = 60_000;

// One persistent gate shared by search and checking; never allow a restart to reset the interval.
export function createScanRequestGate(store, { now = Date.now, sleep = delay, signal } = {}) {
  let chain = Promise.resolve();
  return operation => {
    const result = chain.then(async () => {
      signal?.throwIfAborted();
      const state = await store.read();
      const last = Date.parse(state.lastRequestAt);
      let remaining = Number.isFinite(last) ? last + scanRequestIntervalMs - now() : 0;
      while (remaining > 0) {
        await sleep(remaining, undefined, { signal });
        remaining = last + scanRequestIntervalMs - now();
      }
      signal?.throwIfAborted();
      await store.update(current => { current.lastRequestAt = new Date(now()).toISOString(); });
      try { return await operation(); }
      finally {
        // Count the pause from completion as well, including failed or long agent runs.
        await store.update(current => { current.lastRequestAt = new Date(now()).toISOString(); });
      }
    });
    chain = result.catch(() => {});
    return result;
  };
}
