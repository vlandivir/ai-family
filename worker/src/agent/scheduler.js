export function createScheduler(maxConcurrent = 3) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("MAX_CONCURRENT_AGENTS must be a positive integer");
  }

  const pending = [];
  const active = new Set();
  const idleWaiters = [];
  let paused = false;

  function drain() {
    if (paused) return;
    while (active.size < maxConcurrent) {
      const index = pending.findIndex(({ key }) => !active.has(key));
      if (index < 0) return;
      const [{ key, task }] = pending.splice(index, 1);
      active.add(key);
      Promise.resolve()
        .then(task)
        .catch((error) => console.error("scheduled task", error))
        .finally(() => {
          active.delete(key);
          if (active.size === 0) {
            for (const resolve of idleWaiters.splice(0)) resolve();
          }
          drain();
        });
    }
  }

  return {
    enqueue(key, task) {
      if (paused) return false;
      const queued = active.has(key) || pending.length > 0 || active.size >= maxConcurrent;
      pending.push({ key, task });
      drain();
      return queued;
    },
    pause() {
      paused = true;
      pending.length = 0;
      if (active.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
