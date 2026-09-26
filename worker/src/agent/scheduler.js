export function createScheduler(maxConcurrent = 3) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("MAX_CONCURRENT_AGENTS must be a positive integer");
  }

  const pending = [];
  const active = new Set();

  function drain() {
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
          drain();
        });
    }
  }

  return {
    enqueue(key, task) {
      const queued = active.has(key) || pending.length > 0 || active.size >= maxConcurrent;
      pending.push({ key, task });
      drain();
      return queued;
    },
  };
}
