import React, { useState, useCallback } from 'react';
import type { ControlQuestionData } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';

interface Props {
  requestId: string;
  questions: ControlQuestionData[];
  onSubmit: (requestId: string, decision: 'allow' | 'deny', payload?: Record<string, unknown>) => void;
}

export default function QuestionCard({ requestId, questions, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const { t } = useI18nContext();

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setAnswers((prev) => {
      const current = prev[qIdx] ?? [];
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [qIdx]: next };
      } else {
        if (label !== '__other__') {
          setOtherTexts((ot) => ({ ...ot, [qIdx]: '' }));
        }
        return { ...prev, [qIdx]: [label] };
      }
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIdx]: text }));
    setAnswers((prev) => {
      const q = questions[qIdx];
      if (q.multiSelect) {
        const current = prev[qIdx] ?? [];
        if (!current.includes('__other__')) {
          return { ...prev, [qIdx]: [...current, '__other__'] };
        }
        return prev;
      } else {
        return { ...prev, [qIdx]: ['__other__'] };
      }
    });
  }, [questions]);

  const allAnswered = questions.every((_, idx) => {
    const selected = answers[idx] ?? [];
    if (selected.length === 0) return false;
    if (selected.includes('__other__') && !(otherTexts[idx]?.trim())) return false;
    return true;
  });

  const handleSubmit = () => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);

    const answersMap: Record<string, string> = {};
    questions.forEach((_, idx) => {
      const selected = answers[idx] ?? [];
      const labels = selected.map((s) => s === '__other__' ? (otherTexts[idx]?.trim() ?? '') : s);
      answersMap[String(idx)] = labels.join(',');
    });

    onSubmit(requestId, 'allow', { answers: answersMap });
  };

  const handleDeny = () => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit(requestId, 'deny');
  };

  return (
    <div className="rounded-lg px-4 py-3 mb-2 bg-info-surface border border-info/40">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-info font-semibold">{t('questionCard.title')}</span>
        {!submitted && (
          <button
            onClick={handleDeny}
            className="px-2.5 py-1 rounded bg-danger/60 hover:bg-danger text-white text-xs font-medium transition-colors"
          >
            {t('common.dismiss')}
          </button>
        )}
      </div>

      {questions.map((q, qIdx) => {
        const selected = answers[qIdx] ?? [];
        return (
          <div key={qIdx} className={`${qIdx > 0 ? 'mt-4 pt-3 border-t border-outline/40' : ''}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs bg-info-surface text-info px-2 py-0.5 rounded-full font-medium">
                {q.header}
              </span>
              {q.multiSelect && (
                <span className="text-xs text-on-surface-muted">{t('questionCard.multiSelect')}</span>
              )}
            </div>
            <div className="text-sm text-on-surface mb-2">{q.question}</div>

            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => {
                const isSelected = selected.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    disabled={submitted}
                    onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                    className={`text-left rounded-md px-3 py-2 border transition-colors ${
                      submitted
                        ? isSelected
                          ? 'border-info/60 bg-info-surface text-on-surface'
                          : 'border-outline/30 bg-surface-elevated/20 text-on-surface-muted'
                        : isSelected
                          ? 'border-info/60 bg-info-surface text-on-surface'
                          : 'border-outline/40 bg-surface-elevated/30 text-on-surface-secondary hover:border-info/40 hover:bg-info-surface/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {q.multiSelect ? (
                        <span className={`w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 flex items-center justify-center ${
                          isSelected ? 'border-info bg-info' : 'border-on-surface-muted'
                        }`}>
                          {isSelected && <span className="text-white text-[10px] font-bold">✓</span>}
                        </span>
                      ) : (
                        <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${
                          isSelected ? 'border-info bg-info' : 'border-on-surface-muted'
                        }`} />
                      )}
                      <span className="text-sm font-medium">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <div className="text-xs text-on-surface-secondary mt-0.5 ml-[22px]">{opt.description}</div>
                    )}
                  </button>
                );
              })}

              <div
                className={`rounded-md px-3 py-2 border transition-colors ${
                  submitted
                    ? selected.includes('__other__')
                      ? 'border-info/60 bg-info-surface'
                      : 'border-outline/30 bg-surface-elevated/20'
                    : selected.includes('__other__')
                      ? 'border-info/60 bg-info-surface'
                      : 'border-outline/40 bg-surface-elevated/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  {q.multiSelect ? (
                    <span
                      onClick={() => !submitted && toggleOption(qIdx, '__other__', true)}
                      className={`w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 flex items-center justify-center cursor-pointer ${
                        selected.includes('__other__') ? 'border-info bg-info' : 'border-on-surface-muted'
                      }`}
                    >
                      {selected.includes('__other__') && <span className="text-white text-[10px] font-bold">✓</span>}
                    </span>
                  ) : (
                    <span
                      onClick={() => !submitted && toggleOption(qIdx, '__other__', false)}
                      className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 cursor-pointer ${
                        selected.includes('__other__') ? 'border-info bg-info' : 'border-on-surface-muted'
                      }`}
                    />
                  )}
                  <input
                    type="text"
                    disabled={submitted}
                    placeholder={t('questionCard.otherPlaceholder')}
                    value={otherTexts[qIdx] ?? ''}
                    onChange={(e) => setOtherText(qIdx, e.target.value)}
                    className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder-on-surface-muted outline-none"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {!submitted && (
        <div className="flex justify-end mt-3">
          <button
            disabled={!allAnswered}
            onClick={handleSubmit}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              allAnswered
                ? 'bg-info hover:bg-info/80 text-white'
                : 'bg-surface-elevated text-on-surface-muted cursor-not-allowed'
            }`}
          >
            {t('common.confirm')}
          </button>
        </div>
      )}

      {submitted && (
        <div className="text-xs text-on-surface-muted mt-2 text-right italic">
          {t('questionCard.answersSubmitted')}
        </div>
      )}
    </div>
  );
}
