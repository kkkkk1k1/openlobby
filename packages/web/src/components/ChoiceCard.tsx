import React, { useState } from 'react';

export interface ChoiceOption {
  label: string;
  description: string;
}

interface Props {
  question: string;
  options: ChoiceOption[];
  onSelect: (label: string) => void;
}

export default function ChoiceCard({ question, options, onSelect }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const handleConfirm = () => {
    if (selected) {
      setConfirmed(true);
      onSelect(selected);
    }
  };

  return (
    <div className="rounded-lg px-4 py-3 my-2 bg-warning-surface border border-warning/40">
      <div className="text-sm text-warning font-medium mb-3">{question}</div>
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const isSelected = selected === opt.label;
          return (
            <button
              key={opt.label}
              disabled={confirmed}
              onClick={() => !confirmed && setSelected(opt.label)}
              className={`text-left rounded-md px-3 py-2 border transition-colors ${
                confirmed
                  ? isSelected
                    ? 'border-warning/60 bg-warning-surface text-on-surface'
                    : 'border-outline/30 bg-surface-elevated/20 text-on-surface-muted'
                  : isSelected
                    ? 'border-warning/60 bg-warning-surface text-on-surface'
                    : 'border-outline/40 bg-surface-elevated/30 text-on-surface-secondary hover:border-warning/40 hover:bg-warning-surface/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${
                  isSelected
                    ? 'border-warning bg-warning'
                    : 'border-on-surface-muted'
                }`}>
                  {isSelected && (
                    <span className="block w-full h-full rounded-full bg-warning" />
                  )}
                </span>
                <span className="text-sm font-medium">{opt.label}</span>
              </div>
              <div className="text-xs text-on-surface-secondary mt-0.5 ml-5.5 pl-0.5">{opt.description}</div>
            </button>
          );
        })}
      </div>
      {!confirmed && (
        <div className="flex justify-end mt-3">
          <button
            disabled={!selected}
            onClick={handleConfirm}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              selected
                ? 'bg-warning hover:bg-warning-hover text-white'
                : 'bg-surface-elevated text-on-surface-muted cursor-not-allowed'
            }`}
          >
            Select & Continue
          </button>
        </div>
      )}
      {confirmed && (
        <div className="text-xs text-on-surface-muted mt-2 text-right italic">
          Selected: {selected}
        </div>
      )}
    </div>
  );
}
