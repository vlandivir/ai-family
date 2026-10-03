// The Telegram poller accepts both private chats and family groups.
// A matching sender in a group is never enough to expose the owner's MCP.
export function isOwnerPrivateMessage(message, ownerId = process.env.VLANDIVIR_MCP_OWNER_USER_ID) {
  const expected = String(ownerId || "").trim();
  return /^\d+$/.test(expected)
    && message?.chatType === "private"
    && message.inGroup === false
    && String(message.userId) === expected
    && String(message.chatId) === expected;
}

// Jobs may wait in Supabase or be retried after a worker restart. Require
// both the decision made when Telegram delivered the message and a fresh
// identity check immediately before starting the agent.
export function ownerMcpContextForJob(job, ownerId = process.env.VLANDIVIR_MCP_OWNER_USER_ID) {
  const message = job?.payload?.message;
  if (job?.payload?.ownerMcpEligible !== true || !isOwnerPrivateMessage(message, ownerId)) {
    return null;
  }
  return { chatId: String(message.chatId) };
}
