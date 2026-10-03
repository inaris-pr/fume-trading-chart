/**
 * Reference indicator panel: add SMA / EMA / Volume / RSI, edit their parameters, toggle
 * visibility, remove them. Pure host UI: every action is one call on the chart handle
 * (addIndicator / updateIndicator / removeIndicator); calculation, panes and validation live in
 * the chart engine and @fume/indicators.
 */
import { useState } from 'react';
import {
  BUILTIN_INDICATORS,
  type IndicatorDefinition,
  type IndicatorInstance,
  type IndicatorParamSpec,
  type IndicatorPatch,
} from '@fume/chart';
import { Icon } from './icons.tsx';

const DEFINITIONS = new Map(BUILTIN_INDICATORS.map((d) => [d.type, d]));
const SHORT_NAME: Readonly<Record<string, string>> = {
  sma: 'SMA',
  ema: 'EMA',
  volume: 'Volume',
  rsi: 'RSI',
};

export function IndicatorPanel(props: {
  indicators: readonly IndicatorInstance[];
  onAdd: (type: string) => void;
  onUpdate: (id: string, patch: IndicatorPatch) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="drawing-list indicator-panel" role="dialog" aria-label="Indicators">
      <div className="drawing-list-header">
        <span>Indicators</span>
        <button type="button" aria-label="Close indicators" onClick={props.onClose}>
          {Icon.close}
        </button>
      </div>
      <div className="indicator-add" role="group" aria-label="Add indicator">
        {BUILTIN_INDICATORS.map((d) => (
          <button
            key={d.type}
            type="button"
            title={`Add ${d.name}`}
            onClick={() => props.onAdd(d.type)}
          >
            + {SHORT_NAME[d.type] ?? d.name}
          </button>
        ))}
      </div>
      {props.indicators.length === 0 && <div className="drawing-list-empty">No indicators</div>}
      <ul>
        {props.indicators.map((instance) => {
          const definition = DEFINITIONS.get(instance.type);
          return definition ? (
            <IndicatorRow
              key={instance.id}
              instance={instance}
              definition={definition}
              onUpdate={(patch) => props.onUpdate(instance.id, patch)}
              onRemove={() => props.onRemove(instance.id)}
            />
          ) : null;
        })}
      </ul>
    </div>
  );
}

function IndicatorRow(props: {
  instance: IndicatorInstance;
  definition: IndicatorDefinition;
  onUpdate: (patch: IndicatorPatch) => void;
  onRemove: () => void;
}) {
  const { instance, definition } = props;
  const swatch = String(
    instance.style[definition.outputs[0]!.color] ?? instance.style.color ?? 'transparent',
  );
  const name = SHORT_NAME[definition.type] ?? definition.name;
  return (
    <li className={instance.visible ? '' : 'is-hidden'}>
      <span className="indicator-name" title={definition.name}>
        <span className="swatch" style={{ background: swatch }} />
        {name}
      </span>
      {definition.params.map((spec) => (
        <ParamInput
          key={spec.key}
          spec={spec}
          value={instance.params[spec.key]!}
          label={`${name} ${spec.label.toLowerCase()}`}
          onCommit={(value) => props.onUpdate({ params: { [spec.key]: value } })}
        />
      ))}
      <button
        type="button"
        aria-label={instance.visible ? `Hide ${name}` : `Show ${name}`}
        title={instance.visible ? 'Hide' : 'Show'}
        aria-pressed={!instance.visible}
        onClick={() => props.onUpdate({ visible: !instance.visible })}
      >
        {instance.visible ? Icon.visible : Icon.hidden}
      </button>
      <button type="button" aria-label={`Remove ${name}`} title="Remove" onClick={props.onRemove}>
        {Icon.trash}
      </button>
    </li>
  );
}

/** Integer input: applies valid values as they are typed; an invalid draft is shown, not applied. */
function ParamInput(props: {
  spec: IndicatorParamSpec;
  value: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const { spec } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(props.value);
  const valid = (text: string) => {
    const n = Number(text);
    return text.trim() !== '' && Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : null;
  };
  return (
    <input
      className={`indicator-param${draft !== null && valid(draft) === null ? ' invalid' : ''}`}
      type="number"
      inputMode="numeric"
      min={spec.min}
      max={spec.max}
      step={1}
      aria-label={props.label}
      title={`${spec.label} (${spec.min}–${spec.max})`}
      value={shown}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const n = valid(text);
        if (n !== null && n !== props.value) props.onCommit(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
