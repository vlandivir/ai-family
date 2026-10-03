export type ConversationVisibility = {
  kind: "private" | "topic";
  opened_by: string | null;
  telegram_chat_id: number;
};

export function canViewConversation(
  conversation: ConversationVisibility,
  viewerEmail: string,
  ownerEmail: string | undefined,
  ownerUserId: string | undefined,
): boolean {
  if (conversation.kind !== "private") return true;
  const expectedEmail = ownerEmail?.trim().toLowerCase();
  const expectedId = ownerUserId?.trim();
  return Boolean(expectedEmail && expectedId && /^\d+$/.test(expectedId)
    && viewerEmail.trim().toLowerCase() === expectedEmail
    && conversation.opened_by === expectedId
    && String(conversation.telegram_chat_id) === expectedId);
}
