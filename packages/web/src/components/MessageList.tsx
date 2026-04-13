import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';
import MessageBubble from './MessageBubble';
import ControlCard from './ControlCard';
import QuestionCard from './QuestionCard';
import TypingIndicator from './TypingIndicator';
import ToolSummaryBubble from './ToolSummaryBubble';

const EMPTY_MESSAGES: never[] = [];
const EMPTY_CONTROLS: import('../stores/lobby-store').ControlRequestData[] = [];

interface Props {
  sessionId: string;
  onControlRespond: (sessionId: string, requestId: string, decision: 'allow' | 'deny', payload?: Record<string, unknown>) => void;
  onChoiceSelect?: (label: string) => void;
}

export default function MessageList({ sessionId, onControlRespond, onChoiceSelect }: Props) {
  const messages = useLobbyStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const pendingControls = useLobbyStore((s) => s.pendingControlBySession[sessionId] ?? EMPTY_CONTROLS);
  const isTyping = useLobbyStore((s) => s.typingBySession[sessionId] ?? false);
  const toolAggregator = useLobbyStore((s) => s.toolAggregatorBySession[sessionId]);
  const sessionData = useLobbyStore((s) => s.sessions[sessionId]);
  const { t } = useI18nContext();

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevMessageCount = useRef(0);
  const prevSessionId = useRef(sessionId);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 80;
    setUserScrolledUp(!isNearBottom);
    if (isNearBottom) setHasNewMessages(false);
  }, []);

  useEffect(() => {
    if (sessionId !== prevSessionId.current) {
      prevSessionId.current = sessionId;
      prevMessageCount.current = 0;
      setUserScrolledUp(false);
      setHasNewMessages(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const count = messages.length;
    if (count > prevMessageCount.current) {
      const isHistoryLoad = prevMessageCount.current === 0 && count > 1;
      if (userScrolledUp && !isHistoryLoad) {
        setHasNewMessages(true);
      } else {
        bottomRef.current?.scrollIntoView({ behavior: isHistoryLoad ? 'instant' : 'smooth' });
      }
    }
    prevMessageCount.current = count;
  }, [messages, userScrolledUp]);

  useEffect(() => {
    if (!userScrolledUp) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isTyping, pendingControls, userScrolledUp]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setHasNewMessages(false);
    setUserScrolledUp(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 relative" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && pendingControls.length === 0 && !isTyping && (
        <div className="text-on-surface-muted text-center mt-20 text-sm">
          {t('messageList.empty')}
        </div>
      )}

      {messages.map((msg) =>
        msg.type === 'tool_summary' ? (
          <ToolSummaryBubble key={msg.id} summaryText={msg.content as string} />
        ) : (
          <MessageBubble key={msg.id} msg={msg} onChoiceSelect={onChoiceSelect} />
        )
      )}

      {pendingControls.map((ctrl) => (
        ctrl.questions && ctrl.questions.length > 0 ? (
          <QuestionCard
            key={ctrl.requestId}
            requestId={ctrl.requestId}
            questions={ctrl.questions}
            onSubmit={(requestId, decision, payload) =>
              onControlRespond(sessionId, requestId, decision, payload)
            }
          />
        ) : (
          <ControlCard
            key={ctrl.requestId}
            request={ctrl}
            onRespond={(requestId, decision) =>
              onControlRespond(sessionId, requestId, decision)
            }
          />
        )
      ))}

      {sessionData?.messageMode === 'msg-tidy' && toolAggregator?.isAggregating && (
        <ToolSummaryBubble aggregator={toolAggregator} />
      )}

      {isTyping && <TypingIndicator />}

      <div ref={bottomRef} />

      {hasNewMessages && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 bg-primary hover:bg-primary-hover text-primary-on text-xs px-3 py-1.5 rounded-full shadow-lg transition-colors"
        >
          {t('messageList.newMessages')}
        </button>
      )}
    </div>
  );
}
