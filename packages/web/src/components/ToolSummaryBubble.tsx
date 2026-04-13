import React from 'react';
import type { ToolCallAggregator } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';

interface Props {
  aggregator?: ToolCallAggregator;
  summaryText?: string;
}

export default function ToolSummaryBubble({ aggregator, summaryText }: Props) {
  const { t } = useI18nContext();

  if (summaryText) {
    return (
      <div className="flex justify-start px-4 py-1">
        <div className="bg-surface-elevated/50 border border-outline-subtle/50 rounded-lg px-3 py-2 text-xs text-on-surface-secondary max-w-lg">
          {summaryText}
        </div>
      </div>
    );
  }

  if (!aggregator || !aggregator.isAggregating) return null;

  const statsChain = Object.entries(aggregator.toolCounts)
    .map(([name, count]) => `${name}(${count})`)
    .join(' -> ');

  const lastPreview = aggregator.lastToolContent
    ? aggregator.lastToolContent.slice(0, 200) + (aggregator.lastToolContent.length > 200 ? '...' : '')
    : '';

  return (
    <div className="flex justify-start px-4 py-1">
      <div className="bg-surface-elevated/50 border border-outline-subtle/50 rounded-lg px-3 py-2 text-xs max-w-lg animate-pulse">
        <div className="text-on-surface-secondary">
          {'\u{1F527}'} {t('toolSummary.processing', { stats: statsChain })}
        </div>
        {lastPreview && (
          <>
            <div className="border-t border-outline-subtle/50 my-1" />
            <div className="text-on-surface-muted font-mono whitespace-pre-wrap break-all">
              {'\u{1F4C4}'} {t('toolSummary.lastPreview', { tool: aggregator.lastToolName, preview: lastPreview })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
