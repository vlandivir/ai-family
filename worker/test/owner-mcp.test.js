import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { run } from "../src/agent/run.js";
import { isOwnerPrivateMessage, ownerMcpContextForJob } from "../src/owner-mcp.js";

const ownerId = "12345";
const ownerPrivate = { userId: ownerId, chatId: 12345, chatType: "private", inGroup: false };
const ownerGroup = { userId: ownerId, chatId: -100123, chatType: "supergroup", inGroup: true };
const otherPrivate = { userId: "98765", chatId: 98765, chatType: "private", inGroup: false };

test("only the owner's private Telegram message is eligible at intake", () => {
  assert.equal(isOwnerPrivateMessage(ownerPrivate, ownerId), true);
  assert.equal(isOwnerPrivateMessage(ownerGroup, ownerId), false);
  assert.equal(isOwnerPrivateMessage(otherPrivate, ownerId), false);
  assert.equal(isOwnerPrivateMessage(ownerPrivate, ""), false);
  assert.equal(isOwnerPrivateMessage({ ...ownerPrivate, chatId: 99999 }, ownerId), false);
});

test("queued jobs are rechecked before the owner MCP context is granted", () => {
  const job = (message, ownerMcpEligible = true) => ({ payload: { message, ownerMcpEligible } });
  assert.deepEqual(ownerMcpContextForJob(job(ownerPrivate), ownerId), { chatId: ownerId });
  assert.equal(ownerMcpContextForJob(job(ownerPrivate, false), ownerId), null);
  assert.equal(ownerMcpContextForJob(job(ownerGroup), ownerId), null);
  assert.equal(ownerMcpContextForJob(job(otherPrivate), ownerId), null);
  assert.equal(ownerMcpContextForJob(job(ownerPrivate), "88888"), null);
});

async function spawnedEnv(ownerMcp) {
  let captured;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawnChild = (_bin, _args, options) => {
    captured = options.env;
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  await run(["-p"], "/tmp", {
    spawnChild,
    ownerMcp,
    baseEnv: {
      CURSOR_API_KEY: "cursor-test",
      VLANDIVIR_MCP_API_KEY: "main-test",
      VLANDIVIR_GTD_MCP_TOKEN: "gtd-test",
      VLANDIVIR_MCP_CHAT_ID: "stale-chat",
    },
  });
  return captured;
}

test("other agent processes do not inherit owner MCP credentials", async () => {
  const env = await spawnedEnv(null);
  assert.equal(env.CURSOR_API_KEY, "cursor-test");
  assert.equal(env.VLANDIVIR_MCP_API_KEY, undefined);
  assert.equal(env.VLANDIVIR_GTD_MCP_TOKEN, undefined);
  assert.equal(env.VLANDIVIR_MCP_CHAT_ID, undefined);
});

test("group and other private jobs spawn agents without owner credentials", async () => {
  for (const message of [ownerGroup, otherPrivate]) {
    const context = ownerMcpContextForJob({ payload: { message, ownerMcpEligible: true } }, ownerId);
    const env = await spawnedEnv(context);
    assert.equal(env.VLANDIVIR_MCP_API_KEY, undefined);
    assert.equal(env.VLANDIVIR_GTD_MCP_TOKEN, undefined);
    assert.equal(env.VLANDIVIR_MCP_CHAT_ID, undefined);
  }
});

test("only the verified owner context receives MCP credentials and chat id", async () => {
  const context = ownerMcpContextForJob({
    payload: { message: ownerPrivate, ownerMcpEligible: true },
  }, ownerId);
  const env = await spawnedEnv(context);
  assert.equal(env.VLANDIVIR_MCP_API_KEY, "main-test");
  assert.equal(env.VLANDIVIR_GTD_MCP_TOKEN, "gtd-test");
  assert.equal(env.VLANDIVIR_MCP_CHAT_ID, ownerId);
});
