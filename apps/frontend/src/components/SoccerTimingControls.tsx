import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pause, Play, Plus, RotateCcw } from "lucide-react";
import {
  clockIsAtStop,
  computeClockSeconds,
  formatClock,
  pauseClock,
  setClockSeconds,
  tryParseClockTime,
  type PositionPreset,
  type SoccerState
} from "@openoverlay/shared";

const positionOptions: PositionPreset[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

export function SyncedTimeInput({
  seconds,
  disabled = false,
  onCommit,
  minSeconds = 0,
  maxSeconds = Infinity,
  describedBy,
  onValidityChange
}: {
  seconds: number;
  disabled?: boolean;
  onCommit: (seconds: number) => void;
  minSeconds?: number;
  maxSeconds?: number;
  describedBy?: string;
  onValidityChange?: (valid: boolean) => void;
}) {
  const formatted = formatClock(seconds);
  const [draft, setDraft] = useState(formatted);
  const [invalid, setInvalid] = useState(false);
  const focusedRef = useRef(false);
  const editedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatted);
      setInvalid(false);
    }
  }, [formatted]);

  return (
    <input
      value={draft}
      disabled={disabled}
      inputMode="numeric"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      title={
        invalid
          ? `Enter a time from ${formatClock(minSeconds)} to ${Number.isFinite(maxSeconds) ? formatClock(maxSeconds) : "the supported clock limit"}`
          : undefined
      }
      onFocus={() => {
        focusedRef.current = true;
        editedRef.current = false;
      }}
      onChange={(event) => {
        editedRef.current = true;
        setDraft(event.target.value);
        setInvalid(false);
        onValidityChange?.(false);
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (!editedRef.current) {
          setDraft(formatted);
          setInvalid(false);
          return;
        }
        const parsed = tryParseClockTime(draft);
        if (parsed === null || parsed < minSeconds || parsed > maxSeconds) {
          setInvalid(true);
          onValidityChange?.(false);
          return;
        }
        setInvalid(false);
        onValidityChange?.(true);
        setDraft(formatClock(parsed));
        onCommit(parsed);
      }}
    />
  );
}

// Tick only the controls that display time, using the same monotonic server
// anchor as the overlay. Stop scheduling once a finite timer has expired.
export function useControlTime(serverTimeMs: number | undefined, deadline: number | null) {
  const anchor = useMemo(() => ({ server: serverTimeMs ?? Date.now(), received: performance.now() }), [serverTimeMs]);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    let timer: number | undefined;
    const schedule = () => {
      const remaining = deadline - (anchor.server + performance.now() - anchor.received);
      if (remaining <= 0) return;
      timer = window.setTimeout(
        () => {
          refresh((value) => value + 1);
          schedule();
        },
        Math.min(250, remaining)
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [anchor, deadline]);
  return anchor.server + performance.now() - anchor.received;
}

export function SoccerCountdownPanel({
  state,
  serverTimeMs,
  updatePackage,
  runAction
}: {
  state: SoccerState;
  serverTimeMs?: number;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const countdown = state.soccerPackage.countdown;
  const deadline = countdown.running && countdown.startedAtMs !== null ? countdown.startedAtMs + countdown.seconds * 1000 : null;
  const now = useControlTime(serverTimeMs, deadline);
  const running = countdown.running && (deadline === null || now < deadline);

  function updateCountdown(patch: Partial<SoccerState["soccerPackage"]["countdown"]>) {
    updatePackage({ countdown: { ...state.soccerPackage.countdown, ...patch } });
  }

  function startPresetCountdown(seconds: number) {
    void runAction("countdown-start", { durationSeconds: seconds });
  }

  return (
    <section className="control-section countdown-panel">
      <h2>Countdown</h2>
      <div className="form-grid">
        <div className="control-row">
          <button
            className="button primary icon-toggle"
            type="button"
            aria-label={running ? "Stop countdown" : "Start countdown"}
            title={running ? "Stop countdown" : "Start countdown"}
            onClick={() => void runAction("countdown-toggle")}
          >
            {running ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} />}
          </button>
          <button className="button" type="button" onClick={() => startPresetCountdown(300)}>
            5:00
          </button>
          <button className="button" type="button" onClick={() => startPresetCountdown(600)}>
            10:00
          </button>
          <button className="button" type="button" onClick={() => void runAction("countdown-reset")}>
            Reset
          </button>
        </div>
        <div className="two-col">
          <label className="field">
            <span>Custom length</span>
            <SyncedTimeInput
              seconds={state.soccerPackage.countdown.resetSeconds}
              onCommit={(seconds) => {
                updateCountdown({ seconds, resetSeconds: seconds, running: false, startedAtMs: null });
              }}
            />
          </label>
          <label className="field">
            <span>Mode</span>
            <select
              value={state.soccerPackage.countdown.mode}
              onChange={(event) => updateCountdown({ mode: event.target.value as SoccerState["soccerPackage"]["countdown"]["mode"] })}
            >
              <option value="full">Full page</option>
              <option value="small">Small</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Position</span>
          <select
            value={state.soccerPackage.countdown.position}
            disabled={state.soccerPackage.countdown.mode !== "small"}
            onChange={(event) => updateCountdown({ position: event.target.value as PositionPreset })}
          >
            {positionOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Countdown label</span>
          <input value={state.soccerPackage.countdown.label} onChange={(event) => updateCountdown({ label: event.target.value })} />
        </label>
      </div>
    </section>
  );
}

export function SoccerScoreClockPanel({
  state,
  serverTimeMs,
  updateClock,
  runAction
}: {
  state: SoccerState;
  serverTimeMs?: number;
  updateClock: (patch: Partial<SoccerState["clock"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const clock = state.clock;
  const distance = clock.mode === "up" ? clock.stopAtSeconds - clock.baseSeconds : clock.baseSeconds - clock.stopAtSeconds;
  const deadline = clock.running ? (clock.stopAtEnabled && clock.startedAtMs !== null ? clock.startedAtMs + Math.max(0, distance) * 1000 : Infinity) : null;
  const now = useControlTime(serverTimeMs, deadline);
  const running = clock.running && !clockIsAtStop(clock, now);
  return (
    <div className="score-clock-panel">
      <section className="score-clock-section">
        <h2>Score</h2>
        <div className="two-col">
          <ScoreControls
            label={state.home.abbreviation}
            score={state.score.home}
            plus={() => runAction("home-score-plus")}
            minus={() => runAction("home-score-minus")}
          />
          <ScoreControls
            label={state.away.abbreviation}
            score={state.score.away}
            plus={() => runAction("away-score-plus")}
            minus={() => runAction("away-score-minus")}
          />
        </div>
      </section>
      <section className="score-clock-section">
        <h2>Clock</h2>
        <div className="control-row">
          <button
            className="button primary icon-toggle"
            type="button"
            aria-label={running ? "Pause clock" : "Start clock"}
            title={running ? "Pause clock" : "Start clock"}
            onClick={() => runAction("clock-toggle")}
          >
            {running ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} />}
          </button>
          <button className="button" type="button" onClick={() => runAction("clock-reset")}>
            <RotateCcw size={15} /> Reset
          </button>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Manual time</span>
            <SyncedTimeInput seconds={computeClockSeconds(state.clock, now)} onCommit={(seconds) => updateClock(setClockSeconds(state.clock, seconds))} />
          </label>
          <div className="two-col">
            <label className="field">
              <span>Mode</span>
              <select
                value={state.clock.mode}
                title="Changing direction pauses the clock at its current time"
                onChange={(event) => {
                  const mode = event.target.value as "up" | "down";
                  const paused = pauseClock(state.clock, now);
                  const validStop = mode === "up" ? paused.stopAtSeconds >= paused.baseSeconds : paused.stopAtSeconds <= paused.baseSeconds;
                  updateClock({ ...paused, mode, stopAtEnabled: paused.stopAtEnabled && validStop });
                }}
              >
                <option value="up">Count up</option>
                <option value="down">Count down</option>
              </select>
            </label>
            <label className="field">
              <span>Period</span>
              <input value={state.clock.periodLabel} onChange={(event) => updateClock({ periodLabel: event.target.value })} />
            </label>
          </div>
          <div className={`clock-toggle-option ${state.clock.stopAtEnabled ? "" : "is-disabled"}`}>
            <div className="clock-toggle-inline">
              <label className="custom-checkbox-control" aria-label="Enable stop at">
                <input type="checkbox" checked={state.clock.stopAtEnabled} onChange={(event) => updateClock({ stopAtEnabled: event.target.checked })} />
                <span className="custom-checkbox-glyph" aria-hidden="true">
                  <Check size={10} />
                </span>
              </label>
              <label className="field">
                <span>Stop at</span>
                <SyncedTimeInput
                  seconds={state.clock.stopAtSeconds}
                  disabled={!state.clock.stopAtEnabled}
                  onCommit={(seconds) => updateClock({ stopAtSeconds: seconds })}
                />
              </label>
            </div>
          </div>
          <div className={`clock-toggle-option ${state.clock.showStoppage ? "" : "is-disabled"}`}>
            <div className="clock-toggle-inline">
              <label className="custom-checkbox-control" aria-label="Enable stoppage time">
                <input type="checkbox" checked={state.clock.showStoppage} onChange={(event) => updateClock({ showStoppage: event.target.checked })} />
                <span className="custom-checkbox-glyph" aria-hidden="true">
                  <Check size={10} />
                </span>
              </label>
              <label className="field">
                <span>Stoppage minutes</span>
                <input
                  type="number"
                  min="0"
                  value={state.clock.stoppageMinutes}
                  disabled={!state.clock.showStoppage}
                  onChange={(event) => updateClock({ stoppageMinutes: Math.max(0, Number(event.target.value)) })}
                />
              </label>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ScoreControls({ label, score, plus, minus }: { label: string; score: number; plus: () => void; minus: () => void }) {
  return (
    <div className="score-control">
      <div className="score-control-row">
        <h3>{label}</h3>
        <strong>{score}</strong>
      </div>
      <div className="score-control-actions">
        <button className="button primary" type="button" onClick={plus} aria-label={`Add point to ${label}`}>
          <Plus size={16} /> 1
        </button>
        <button className="button" type="button" onClick={minus} aria-label={`Subtract point from ${label}`}>
          −1
        </button>
      </div>
    </div>
  );
}
