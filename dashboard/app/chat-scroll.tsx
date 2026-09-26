"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function ChatScroll({ conversationId, lastActivity, children }: {
  conversationId: string;
  lastActivity: string;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const previousConversation = useRef<string | null>(null);
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    const changedConversation = previousConversation.current !== conversationId;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 180;
    if (changedConversation || nearBottom) node.scrollTop = node.scrollHeight;
    previousConversation.current = conversationId;
  }, [conversationId, lastActivity]);
  return <div className="chat-scroll" ref={pane}>{children}</div>;
}
