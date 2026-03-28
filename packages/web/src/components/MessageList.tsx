import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import MessageBubble from './MessageBubble';
import ControlCard from './ControlCard';
import QuestionCard from './QuestionCard';
import TypingIndicator from './TypingIndicator';

const EMPTY_MESSAGES: never[] = [];

interface Props {
  sessionId: string;
  onControlRespond: (sessionId: string, requestId: string, decision: 'allow' | 'deny', payload?: Record<string, unknown>) => void;
  onChoiceSelect?: (label: string) => void;
}

export default function MessageList({ sessionId, onControlRespond, onChoiceSelect }: Props) {
  const messages = useLobbyStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const pendingControl = useLobbyStore((s) => s.pendingControlBySession[sessionId] ?? null);
  const isTyping = useLobbyStore((s) => s.typingBySession[sessionId] ?? false);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevMessageCount = useRef(0);
  const prevSessionId = useRef(sessionId);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 80;
    setUserScrolledUp(!isNearBottom);
    if (isNearBottom) setHasNewMessages(false);
  }, []);

  // Reset state on session switch
  useEffect(() => {
    if (sessionId !== prevSessionId.current) {
      prevSessionId.current = sessionId;
      prevMessageCount.current = 0;
      setUserScrolledUp(false);
      setHasNewMessages(false);
    }
  }, [sessionId]);

  // Auto-scroll or show "new messages" indicator
  useEffect(() => {
    const count = messages.length;
    if (count > prevMessageCount.current) {
      // Session switch (history load): jump instantly; new messages: smooth scroll
      const isHistoryLoad = prevMessageCount.current === 0 && count > 1;
      if (userScrolledUp && !isHistoryLoad) {
        setHasNewMessages(true);
      } else {
        bottomRef.current?.scrollIntoView({ behavior: isHistoryLoad ? 'instant' : 'smooth' });
      }
    }
    prevMessageCount.current = count;
  }, [messages, userScrolledUp]);

  // Auto-scroll for typing indicator and control cards
  useEffect(() => {
    if (!userScrolledUp) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isTyping, pendingControl, userScrolledUp]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setHasNewMessages(false);
    setUserScrolledUp(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 relative" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && !pendingControl && !isTyping && (
        <div className="text-gray-500 text-center mt-20 text-sm">
          Send a message to start the conversation.
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} onChoiceSelect={onChoiceSelect} />
      ))}

      {pendingControl && (
        pendingControl.questions && pendingControl.questions.length > 0 ? (
          <QuestionCard
            requestId={pendingControl.requestId}
            questions={pendingControl.questions}
            onSubmit={(requestId, decision, payload) =>
              onControlRespond(sessionId, requestId, decision, payload)
            }
          />
        ) : (
          <ControlCard
            request={pendingControl}
            onRespond={(requestId, decision) =>
              onControlRespond(sessionId, requestId, decision)
            }
          />
        )
      )}

      {isTyping && <TypingIndicator />}

      <div ref={bottomRef} />

      {/* New messages indicator */}
      {hasNewMessages && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-full shadow-lg transition-colors"
        >
          New messages
        </button>
      )}
    </div>
  );
}
