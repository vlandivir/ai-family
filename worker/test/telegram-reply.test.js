import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sendAnswer, sendMessage } from "../src/telegram/poll.js";

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;

after(() => {
  globalThis.fetch = originalFetch;
  if (originalToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
});

test("every response chunk replies to the incoming message", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: {} }) };
  };

  await sendMessage(-100, "a".repeat(4500), 28, 42);
  await sendAnswer(-100, "Ответ", 28, 43);

  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((body) => body.reply_parameters.message_id), [42, 42, 43]);
  assert.ok(bodies.every((body) => body.message_thread_id === 28));
});
