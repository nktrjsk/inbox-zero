"use client";

import { useChat as useAiChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { parseAsString, useQueryState } from "nuqs";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSWRConfig } from "swr";
import { captureException } from "@/utils/error";
import { convertToUIMessages } from "@/components/assistant-chat/helpers";
import type { ChatMessage } from "@/components/assistant-chat/types";
import { useChatMessages } from "@/hooks/useChatMessages";
import { useAccount } from "@/providers/EmailAccountProvider";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { InlineEmailActionProvider } from "@/components/assistant-chat/inline-email-action-context";
import {
  mergeInlineEmailActions,
  type InlineEmailAction,
  type InlineEmailActionType,
} from "@/utils/ai/assistant/inline-email-actions";

export type Attachment = {
  id: string;
  name: string;
  url: string;
  contentType: string;
};

export type Chat = ReturnType<typeof useAiChat<ChatMessage>>;

type ChatContextType = {
  chat: Chat;
  input: string;
  chatId: string | null;
  persistedMessageIds: Set<string>;
  setInput: (input: string) => void;
  setChatId: (chatId: string | null) => void;
  setNewChat: () => void;
  submitTextMessage: (text: string) => Promise<void>;
  startFixChat: (params: { text: string; context: MessageContext }) => void;
  handleSubmit: () => void;
  context: MessageContext | null;
  setContext: (context: MessageContext | null) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
};

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { emailAccountId } = useAccount();
  const { mutate } = useSWRConfig();

  const [input, setInput] = useState<string>("");
  const [chatId, setChatId] = useQueryState("chatId", parseAsString);
  const [context, setContextState] = useState<MessageContext | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [inlineActions, setInlineActions] = useState<InlineEmailAction[]>([]);
  const inlineActionsRef = useRef(inlineActions);
  const pendingInlineActionsRef = useRef<InlineEmailAction[] | null>(null);
  const previousChatIdRef = useRef(chatId);
  const previousEmailAccountIdRef = useRef<string | null>(null);

  // The send transport reads context at request time from this ref, not from
  // React state, so a caller can set context and send in the same tick without
  // the request closing over a stale value.
  const contextRef = useRef<MessageContext | null>(null);
  const setContext = useCallback((next: MessageContext | null) => {
    contextRef.current = next;
    setContextState(next);
  }, []);

  // A Fix send targets a brand-new chat, but the useAiChat instance only adopts
  // the new id on a later render — so the send is queued here and fired by an
  // effect once the fresh chat has settled.
  const pendingFixRef = useRef<{ chatId: string; text: string } | null>(null);

  const { data } = useChatMessages(chatId);
  const persistedMessageIds = useMemo(
    () => new Set(data?.messages.map((message) => message.id) ?? []),
    [data?.messages],
  );

  const setNewChat = useCallback(() => {
    setChatId(generateUUID());
  }, [setChatId]);

  const queueInlineAction = useCallback(
    (type: InlineEmailActionType, threadIds: string[]) => {
      setInlineActions((current) =>
        mergeInlineEmailActions(current, { type, threadIds }),
      );
    },
    [],
  );

  const chat = useAiChat<ChatMessage>({
    id: chatId ?? undefined,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: {
        [EMAIL_ACCOUNT_HEADER]: emailAccountId,
      },
      prepareSendMessagesRequest({ messages, id, body }) {
        return {
          body: {
            id,
            message: messages.at(-1),
            context: contextRef.current ?? undefined,
            inlineActions: pendingInlineActionsRef.current ?? undefined,
            ...body,
          },
        };
      },
    }),
    // messages: initialMessages, // NOTE: couldn't get this to work
    experimental_throttle: 100,
    generateId: generateUUID,
    onFinish: async () => {
      pendingInlineActionsRef.current = null;
      await Promise.all([
        mutate("/api/user/rules"),
        chatId ? mutate(`/api/chats/${chatId}`) : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      const pendingInlineActions = pendingInlineActionsRef.current;
      if (pendingInlineActions?.length) {
        setInlineActions((current) =>
          pendingInlineActions.reduce(
            (merged, action) => mergeInlineEmailActions(merged, action),
            current,
          ),
        );
        pendingInlineActionsRef.current = null;
      }

      console.error(error);
      captureException(error);
    },
  });

  useEffect(() => {
    chat.setMessages(data ? convertToUIMessages(data) : []);
  }, [chat.setMessages, data]);

  useEffect(() => {
    inlineActionsRef.current = inlineActions;
  }, [inlineActions]);

  useEffect(() => {
    if (previousChatIdRef.current === chatId) return;

    previousChatIdRef.current = chatId;
    pendingInlineActionsRef.current = null;
    setInlineActions([]);
  }, [chatId]);

  useEffect(() => {
    if (!emailAccountId) return;

    if (previousEmailAccountIdRef.current === null) {
      previousEmailAccountIdRef.current = emailAccountId;
      return;
    }

    if (previousEmailAccountIdRef.current === emailAccountId) return;

    previousEmailAccountIdRef.current = emailAccountId;
    pendingInlineActionsRef.current = null;
    setChatId(null);
    chat.setMessages([]);
    setInput("");
    setContext(null);
    setAttachments([]);
    setInlineActions([]);
  }, [chat.setMessages, emailAccountId, setChatId, setContext]);

  const sendMessageParts = useCallback(
    async (
      parts: Array<
        | { type: "file"; url: string; filename: string; mediaType: string }
        | { type: "text"; text: string }
      >,
    ) => {
      if (!chatId) setChatId(chat.id);

      pendingInlineActionsRef.current = inlineActionsRef.current.length
        ? inlineActionsRef.current
        : null;

      if (pendingInlineActionsRef.current) {
        setInlineActions([]);
      }

      await chat.sendMessage({ role: "user", parts });
    },
    [chat.id, chat.sendMessage, chatId, setChatId],
  );

  const submitTextMessage = useCallback(
    async (text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      await sendMessageParts([{ type: "text", text: trimmedText }]);
      setInput("");
    },
    [sendMessageParts],
  );

  const startFixChat = useCallback(
    ({
      text,
      context: fixContext,
    }: {
      text: string;
      context: MessageContext;
    }) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      const newChatId = generateUUID();
      setContext(fixContext);
      pendingFixRef.current = { chatId: newChatId, text: trimmedText };
      setChatId(newChatId);
      setInput("");
    },
    [setChatId, setContext],
  );

  // Fire a queued Fix send once its fresh chat has fully settled: the query
  // state, the useAiChat instance id, and the initial (empty) data load must
  // all match the new chat. Waiting for the null data load means the
  // data->messages effect above has already cleared the chat, so the optimistic
  // send that follows isn't wiped.
  useEffect(() => {
    const pending = pendingFixRef.current;
    if (!pending) return;
    if (chatId !== pending.chatId) return;
    if (chat.id !== pending.chatId) return;
    if (data === undefined) return;

    pendingFixRef.current = null;
    sendMessageParts([{ type: "text", text: pending.text }]).catch(
      captureException,
    );
  }, [chatId, chat.id, data, sendMessageParts]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    const fileParts = attachments.map((attachment) => ({
      type: "file" as const,
      url: attachment.url,
      filename: attachment.name,
      mediaType: attachment.contentType,
    }));

    const parts: Array<
      | { type: "file"; url: string; filename: string; mediaType: string }
      | { type: "text"; text: string }
    > = [...fileParts];

    if (text) {
      parts.push({ type: "text", text });
    }

    sendMessageParts(parts).catch(captureException);
    setAttachments([]);
    setInput("");
  }, [attachments, input, sendMessageParts]);

  return (
    <ChatContext.Provider
      value={{
        chat,
        chatId,
        input,
        persistedMessageIds,
        setInput,
        setChatId,
        setNewChat,
        submitTextMessage,
        startFixChat,
        handleSubmit,
        context,
        setContext,
        attachments,
        setAttachments,
      }}
    >
      <InlineEmailActionProvider value={{ queueAction: queueInlineAction }}>
        {children}
      </InlineEmailActionProvider>
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextType {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}

// NOTE: not sure why we don't just use the default from AI SDK
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
