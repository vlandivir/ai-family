import assert from "node:assert/strict";
import { test } from "node:test";
import { canViewConversation } from "../lib/visibility.ts";

const ownerChat = { kind: "private", opened_by: "12345", telegram_chat_id: 12345 };
const familyTopic = { kind: "topic", opened_by: null, telegram_chat_id: -1001 };

test("owner sees their private chat while another allowed dashboard user does not", () => {
  assert.equal(canViewConversation(ownerChat, "OWNER@example.com", "owner@example.com", "12345"), true);
  assert.equal(canViewConversation(ownerChat, "family@example.com", "owner@example.com", "12345"), false);
  assert.equal(canViewConversation(familyTopic, "family@example.com", "owner@example.com", "12345"), true);
});

test("private chats fail closed when owner configuration or identity does not match", () => {
  assert.equal(canViewConversation(ownerChat, "owner@example.com", undefined, "12345"), false);
  assert.equal(canViewConversation(ownerChat, "owner@example.com", "owner@example.com", undefined), false);
  assert.equal(canViewConversation({ ...ownerChat, opened_by: "999" }, "owner@example.com", "owner@example.com", "12345"), false);
  assert.equal(canViewConversation({ ...ownerChat, telegram_chat_id: 999 }, "owner@example.com", "owner@example.com", "12345"), false);
});
