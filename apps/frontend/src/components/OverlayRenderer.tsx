import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  clockIsAtStop,
  churchOnAirSlide,
  formatSoccerClock,
  type ActiveGraphic,
  type ChurchState,
  type OverlayElementConfig,
  type Placement,
  type PresetState,
  type PresetType,
  type SoccerLabOverlay,
  type SoccerPackageColorBank,
  type SoccerState,
  type SoccerTextAnimationState,
  type SoccerTextAnimationField,
  normalizeChurchState
} from "@openoverlay/shared";
import { mediaApi } from "../lib/api";
import { ChurchSlideContent } from "./ChurchPresentation";
import scorebugLabCssUrl from "../styles/scorebug-lab.css?url";
import scorebugOpenOverlayLabCssUrl from "../styles/scorebug-openoverlay-lab.css?url";

interface OverlayRendererProps {
  type: PresetType;
  state: PresetState;
  serverTimeMs?: number;
  transparent?: boolean;
  safeArea?: boolean;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;
const SOCCER_EXIT_MS = 960;
const SOCCER_SWITCH_ENTER_DELAY_MS = 520;
const SOCCER_COUNTDOWN_HANDOFF_MS = 620;
const SOCCER_CLOCKABLE_OVERLAYS = new Set<SoccerLabOverlay>(["full-matchup", "lower-matchup", "lower-result"]);
type OverlayPhase = "entering" | "exiting";
type ActiveOverlayPhase = OverlayPhase | "live";
type TextAnimationFields = readonly SoccerTextAnimationField[];

const overlayLayerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none"
};

export function OverlayRenderer({ type, state, serverTimeMs, transparent = true, safeArea = false, interactive = false, onDragStart }: OverlayRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  // Anchor incoming snapshots to server time. performance.now keeps clocks and
  // graphic expiry stable if the capture machine changes its wall clock.
  const timeAnchor = useMemo(
    () => ({
      server: serverTimeMs ?? Date.now(),
      received: performance.now()
    }),
    [serverTimeMs]
  );
  const [, tick] = useState(0);
  const now = timeAnchor.server + Math.max(0, performance.now() - timeAnchor.received);
  const soccerNeedsClockTick =
    type === "soccer" &&
    isSoccerState(state) &&
    state.elements.fullscreen.visible &&
    state.soccerPackage.activeOverlay !== null &&
    ((state.clock.running && !clockIsAtStop(state.clock, now)) ||
      (state.soccerPackage.countdown.running && packageCountdownSeconds(state.soccerPackage.countdown, now) > 0));
  const visibleTimedGraphic = state.activeGraphics.some((graphic) => {
    if (graphic.expiresAtMs === null || graphic.expiresAtMs <= now) return false;
    if (type !== "church" || !isChurchState(state)) return true;
    if (state.blackout) return false;
    if (graphic.kind === "countdown") return state.elements.countdown.visible;
    if (graphic.kind === "church-lower-third" || graphic.kind === "lower-third") return state.elements.lowerThird.visible;
    return true;
  });
  const needsClockTick = visibleTimedGraphic || soccerNeedsClockTick;

  useEffect(() => {
    if (!needsClockTick) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [needsClockTick]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const resize = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(node);
    return () => resize.disconnect();
  }, []);

  const scale = Math.min(size.width / BASE_WIDTH, size.height / BASE_HEIGHT);
  const x = (size.width - BASE_WIDTH * scale) / 2;
  const y = (size.height - BASE_HEIGHT * scale) / 2;
  const theme = "style" in state ? state.style.theme : "broadcast";

  return (
    <div ref={containerRef} className={`overlay-viewport ${transparent ? "is-transparent" : "has-fill"} theme-${theme}`}>
      <div
        className="overlay-stage"
        style={{
          width: BASE_WIDTH,
          height: BASE_HEIGHT,
          transform: `translate(${x}px, ${y}px) scale(${scale})`
        }}
      >
        {safeArea ? <div className="safe-area" /> : null}
        {type === "soccer" && isSoccerState(state) ? (
          <SoccerOverlay state={state} now={now} transparent={transparent} interactive={interactive} onDragStart={onDragStart} />
        ) : null}
        {type === "church" && isChurchState(state) ? <ChurchOverlay state={state} now={now} interactive={interactive} onDragStart={onDragStart} /> : null}
        {state.activeGraphics
          .filter(() => !(type === "church" && isChurchState(state) && state.blackout))
          .filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > now)
          .filter((graphic) => !(type === "church" && isChurchManagedGraphic(graphic)))
          .map((graphic) => (
            <TemporaryGraphic key={graphic.id} graphic={graphic} />
          ))}
      </div>
    </div>
  );
}

function SoccerOverlay({
  state,
  now,
  transparent,
  interactive,
  onDragStart
}: {
  state: SoccerState;
  now: number;
  transparent: boolean;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  const soccer = state.soccerPackage;
  const activeOverlay = soccer.activeOverlay;
  const countdownSeconds = packageCountdownSeconds(soccer.countdown, now);
  const timerRunning = soccer.countdown.running && countdownSeconds > 0;
  const [exitingOverlay, setExitingOverlay] = useState<SoccerLabOverlay | null>(null);
  const [renderedActiveOverlay, setRenderedActiveOverlay] = useState<SoccerLabOverlay | null>(activeOverlay);
  const [enteringOverlay, setEnteringOverlay] = useState<SoccerLabOverlay | null>(activeOverlay);
  const [timerActivatingOverlay, setTimerActivatingOverlay] = useState<SoccerLabOverlay | null>(null);
  const initialOverlayRef = useRef(activeOverlay);
  const visibleOverlayRef = useRef(activeOverlay);
  const currentOverlayRef = useRef<SoccerLabOverlay | null>(activeOverlay);
  const pendingOverlayRef = useRef<SoccerLabOverlay | null>(activeOverlay);
  const transitionRunningRef = useRef(false);
  const timerRunningRef = useRef(timerRunning);
  const transitionTimeoutsRef = useRef<number[]>([]);
  const previousTextAnimationIdRef = useRef<number | undefined>(soccer.textAnimation?.id);
  const [activeTextAnimation, setActiveTextAnimation] = useState<SoccerTextAnimationState | null>(null);
  const activeClass = renderedActiveOverlay ? `show-${renderedActiveOverlay}` : "show-none";
  const packageColors = soccer.colorBanks[soccer.overlayPackage];

  const scheduleTransitionStep = useCallback((callback: () => void, delay: number) => {
    const duration = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : delay;
    const timeout = window.setTimeout(() => {
      transitionTimeoutsRef.current = transitionTimeoutsRef.current.filter((item) => item !== timeout);
      callback();
    }, duration);
    transitionTimeoutsRef.current.push(timeout);
  }, []);

  const setVisibleOverlay = useCallback((overlay: SoccerLabOverlay | null) => {
    visibleOverlayRef.current = overlay;
    setRenderedActiveOverlay(overlay);
  }, []);

  const processPendingOverlay = useCallback(
    function processPendingOverlay() {
      if (transitionRunningRef.current) return;

      const currentOverlay = currentOverlayRef.current;
      const targetOverlay = pendingOverlayRef.current;
      if (currentOverlay === targetOverlay) {
        setTimerActivatingOverlay(null);
        setVisibleOverlay(currentOverlay);
        setEnteringOverlay(null);
        setExitingOverlay((current) => (current === currentOverlay ? null : current));
        return;
      }

      transitionRunningRef.current = true;

      if (!currentOverlay && targetOverlay) {
        setTimerActivatingOverlay(null);
        setExitingOverlay(null);
        setVisibleOverlay(targetOverlay);
        setEnteringOverlay(targetOverlay);
        scheduleTransitionStep(() => {
          setEnteringOverlay((current) => (current === targetOverlay ? null : current));
          currentOverlayRef.current = targetOverlay;
          transitionRunningRef.current = false;
          processPendingOverlay();
        }, SOCCER_EXIT_MS);
        return;
      }

      if (currentOverlay && !targetOverlay) {
        setTimerActivatingOverlay(null);
        setEnteringOverlay(null);
        setVisibleOverlay(null);
        setExitingOverlay(currentOverlay);
        scheduleTransitionStep(() => {
          setExitingOverlay((current) => (current === currentOverlay ? null : current));
          currentOverlayRef.current = null;
          transitionRunningRef.current = false;
          processPendingOverlay();
        }, SOCCER_EXIT_MS);
        return;
      }

      if (currentOverlay && targetOverlay) {
        const shouldHandoffCountdown = targetOverlay === "countdown-timer" && timerRunningRef.current && SOCCER_CLOCKABLE_OVERLAYS.has(currentOverlay);

        if (shouldHandoffCountdown) {
          setVisibleOverlay(currentOverlay);
          setEnteringOverlay(null);
          setExitingOverlay(null);
          setTimerActivatingOverlay(currentOverlay);

          scheduleTransitionStep(() => {
            setTimerActivatingOverlay(null);
            setExitingOverlay(currentOverlay);
            setVisibleOverlay(targetOverlay);
            setEnteringOverlay(targetOverlay);
          }, SOCCER_COUNTDOWN_HANDOFF_MS);
          scheduleTransitionStep(() => {
            setExitingOverlay((current) => (current === currentOverlay ? null : current));
            setEnteringOverlay((current) => (current === targetOverlay ? null : current));
            currentOverlayRef.current = targetOverlay;
            transitionRunningRef.current = false;
            processPendingOverlay();
          }, SOCCER_COUNTDOWN_HANDOFF_MS + SOCCER_EXIT_MS);
          return;
        }

        setTimerActivatingOverlay(null);
        setEnteringOverlay(null);
        setVisibleOverlay(null);
        setExitingOverlay(currentOverlay);
        scheduleTransitionStep(() => {
          setExitingOverlay((current) => (current === currentOverlay ? null : current));
        }, SOCCER_EXIT_MS);
        scheduleTransitionStep(() => {
          setVisibleOverlay(targetOverlay);
          setEnteringOverlay(targetOverlay);
        }, SOCCER_SWITCH_ENTER_DELAY_MS);
        scheduleTransitionStep(() => {
          setEnteringOverlay((current) => (current === targetOverlay ? null : current));
          currentOverlayRef.current = targetOverlay;
          transitionRunningRef.current = false;
          processPendingOverlay();
        }, SOCCER_SWITCH_ENTER_DELAY_MS + SOCCER_EXIT_MS);
        return;
      }

      transitionRunningRef.current = false;
    },
    [scheduleTransitionStep, setVisibleOverlay]
  );

  useLayoutEffect(() => {
    timerRunningRef.current = timerRunning;
  }, [timerRunning]);

  useLayoutEffect(() => {
    if (activeOverlay === pendingOverlayRef.current) return;
    pendingOverlayRef.current = activeOverlay;
    if (!activeOverlay) {
      // Clear wins over queued entrances. Exit only what is visible right now.
      transitionTimeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
      transitionTimeoutsRef.current = [];
      transitionRunningRef.current = false;
      currentOverlayRef.current = visibleOverlayRef.current;
      setExitingOverlay(null);
    }
    processPendingOverlay();
  }, [activeOverlay, processPendingOverlay]);

  useLayoutEffect(() => {
    const activeOverlay = initialOverlayRef.current;
    if (!activeOverlay || transitionRunningRef.current) return;
    transitionRunningRef.current = true;
    scheduleTransitionStep(() => {
      setEnteringOverlay((current) => (current === activeOverlay ? null : current));
      currentOverlayRef.current = activeOverlay;
      transitionRunningRef.current = false;
      processPendingOverlay();
    }, SOCCER_EXIT_MS);
  }, [processPendingOverlay, scheduleTransitionStep]);

  useEffect(() => {
    return () => {
      transitionTimeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
      transitionTimeoutsRef.current = [];
      transitionRunningRef.current = false;
    };
  }, []);

  useEffect(() => {
    const animation = soccer.textAnimation;
    if (!animation || animation.id === previousTextAnimationIdRef.current) return;
    previousTextAnimationIdRef.current = animation.id;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setActiveTextAnimation(null);
      return;
    }
    setActiveTextAnimation(animation);
    const timeout = window.setTimeout(() => setActiveTextAnimation((current) => (current?.id === animation.id ? null : current)), 760);
    return () => window.clearTimeout(timeout);
  }, [soccer.textAnimation]);

  const labCssUrl = soccer.overlayPackage === "rounded" ? scorebugLabCssUrl : scorebugOpenOverlayLabCssUrl;
  return (
    <>
      <Positioned element={state.elements.fullscreen} interactive={interactive} onDragStart={onDragStart}>
        <LabFrame cssUrl={labCssUrl}>
          <div
            id="stage"
            className={[
              "broadcast-frame",
              `surface-${soccer.surface}`,
              activeClass,
              transparent ? "is-transparent" : "",
              timerRunning ? "timer-running" : "",
              timerActivatingOverlay ? "timer-activating" : "",
              countdownSeconds >= 3600 ? "countdown-has-hours" : "",
              soccer.lowerResultState === "FINAL" ? "result-final" : "",
              soccer.packageBackground ? "" : "background-off"
            ]
              .filter(Boolean)
              .join(" ")}
            style={
              {
                ...soccerPackageColorVars(soccer.overlayPackage, packageColors),
                "--package-bg-opacity": soccer.packageBackgroundOpacity,
                "--scorebug-width": `${soccer.scorebugWidth}%`
              } as React.CSSProperties
            }
          >
            {exitingOverlay && exitingOverlay !== renderedActiveOverlay ? (
              <div className="overlay-layer overlay-layer-exiting" style={{ ...overlayLayerStyle, zIndex: 3 }}>
                {renderSoccerLabOverlay(exitingOverlay, "exiting", state, now, countdownSeconds, [])}
              </div>
            ) : null}
            {renderedActiveOverlay ? (
              <div className="overlay-layer overlay-layer-active" style={{ ...overlayLayerStyle, zIndex: 4 }}>
                {renderSoccerLabOverlay(
                  renderedActiveOverlay,
                  enteringOverlay === renderedActiveOverlay ? "entering" : "live",
                  state,
                  now,
                  countdownSeconds,
                  activeTextAnimation?.fields ?? []
                )}
              </div>
            ) : null}
          </div>
        </LabFrame>
      </Positioned>
    </>
  );
}

function soccerPackageColorVars(packageName: SoccerState["soccerPackage"]["overlayPackage"], colors: SoccerPackageColorBank): React.CSSProperties {
  if (packageName === "rounded") {
    return {
      "--ink": colors.ink,
      "--muted": colors.muted,
      "--line": colors.line,
      "--gold": colors.gold,
      "--maroon": colors.maroon,
      "--wine": colors.wine,
      "--ivory": colors.ivory,
      "--sky": colors.sky,
      "--blue": colors.blue,
      "--red": colors.red
    } as React.CSSProperties;
  }

  return {
    "--oo-bg": colors.bg,
    "--oo-soft": colors.soft,
    "--oo-ink": colors.ink,
    "--oo-muted": colors.muted,
    "--oo-faint": colors.faint,
    "--oo-red": colors.red,
    "--oo-rule": colors.rule,
    "--oo-panel-gray": colors.panelGray,
    "--ink": colors.ink,
    "--muted": colors.muted,
    "--line": colors.rule,
    "--gold": colors.red,
    "--maroon": colors.ink,
    "--wine": colors.bg,
    "--ivory": colors.bg
  } as React.CSSProperties;
}

function renderSoccerLabOverlay(
  overlay: SoccerLabOverlay,
  phase: ActiveOverlayPhase,
  state: SoccerState,
  now: number,
  countdownSeconds: number,
  textAnimationFields: TextAnimationFields
) {
  const key = `${phase}-${overlay}`;
  switch (overlay) {
    case "full-matchup":
      return <FullMatchup key={key} state={state} countdownSeconds={countdownSeconds} phase={phase} textAnimationFields={textAnimationFields} />;
    case "lower-matchup":
      return <LowerMatchup key={key} state={state} countdownSeconds={countdownSeconds} phase={phase} textAnimationFields={textAnimationFields} />;
    case "lower-result":
      return <LowerResult key={key} state={state} countdownSeconds={countdownSeconds} phase={phase} textAnimationFields={textAnimationFields} />;
    case "lineup-panel":
      return <LineupPanel key={key} state={state} phase={phase} textAnimationFields={textAnimationFields} />;
    case "scorebug":
      return <LabScorebug key={key} state={state} now={now} phase={phase} textAnimationFields={textAnimationFields} />;
    case "countdown-timer":
      return <CountdownOverlay key={key} state={state} countdownSeconds={countdownSeconds} phase={phase} />;
    case "one-line-text":
      return <OneLineText key={key} state={state} phase={phase} textAnimationFields={textAnimationFields} />;
    case "two-line-text":
      return <TwoLineText key={key} state={state} phase={phase} textAnimationFields={textAnimationFields} />;
  }
}

function labOverlayClass(base: string, phase: ActiveOverlayPhase, extra = "") {
  return ["overlay", phase === "entering" || phase === "live" ? "active" : "", base, extra, `overlay-${phase}`].filter(Boolean).join(" ");
}

function textUpdateClass(fields: TextAnimationFields, field: SoccerTextAnimationField) {
  return fields.includes(field) ? "text-updated" : "";
}

function scoreUpdateClass(fields: TextAnimationFields, field: SoccerTextAnimationField) {
  return fields.includes(field) ? "score-increased score-updated" : "";
}

function LabFrame({ cssUrl, children }: { cssUrl: string; children: React.ReactNode }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const frameDocument = `<!doctype html><html><head><meta charset="utf-8" /><link rel="stylesheet" href="${escapeHtmlAttribute(cssUrl)}" /><style>${labHostCss}</style></head><body></body></html>`;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setBody(null);
    const updateBody = () => {
      if (frame.contentDocument?.body) setBody(frame.contentDocument.body);
    };
    updateBody();
    frame.addEventListener("load", updateBody);
    return () => frame.removeEventListener("load", updateBody);
  }, [cssUrl]);

  return (
    <div className="lab-frame-host">
      <iframe ref={frameRef} className="lab-frame" title="Soccer overlay package" scrolling="no" srcDoc={frameDocument} />
      {body ? createPortal(children, body) : null}
    </div>
  );
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const labHostCss = `
  html,
  body {
    width: 1280px;
    height: 720px;
    margin: 0;
    overflow: hidden;
    background: transparent !important;
    color-scheme: light !important;
  }

  body {
    --ink: #f8fafc;
    --muted: #a8b3c7;
    --line: rgba(226, 232, 240, 0.16);
    --gold: #f5bd2f;
    --maroon: #7a1235;
    --wine: #3b0820;
    --ivory: #fff6e4;
    --sky: #75c8ff;
    --blue: #143b94;
    --red: #df1f34;
    background: transparent;
    color-scheme: light !important;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }

  .broadcast-frame {
    width: 1280px !important;
    max-width: none !important;
    height: 720px !important;
    aspect-ratio: auto !important;
    margin: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  .broadcast-frame.is-transparent.surface-pitch,
  .broadcast-frame.is-transparent.surface-checker,
  .broadcast-frame.is-transparent.surface-studio {
    background: transparent !important;
  }

  .team-logo img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform-origin: center;
  }
`;

function ChurchOverlay({
  state,
  now,
  interactive,
  onDragStart
}: {
  state: ChurchState;
  now: number;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  const church = normalizeChurchState(state);
  const slide = churchOnAirSlide(church);
  const lowerThird = [...church.activeGraphics]
    .reverse()
    .find(
      (graphic) => (graphic.kind === "church-lower-third" || graphic.kind === "lower-third") && (graphic.expiresAtMs === null || graphic.expiresAtMs > now)
    );
  const countdown = [...church.activeGraphics]
    .reverse()
    .find((graphic) => graphic.kind === "countdown" && (graphic.expiresAtMs === null || graphic.expiresAtMs > now));
  const countdownSeconds = countdown
    ? countdown.expiresAtMs === null
      ? Math.max(0, Math.ceil(countdown.durationMs / 1000))
      : Math.max(0, Math.ceil((countdown.expiresAtMs - now) / 1000))
    : 0;
  if (church.blackout)
    return <div className="church-blackout" role="img" aria-label="Blackout" style={{ position: "absolute", inset: 0, background: "#000" }} />;
  return (
    <>
      {slide && church.elements.fullscreenSlide.visible ? (
        <Positioned element={church.elements.fullscreenSlide} interactive={interactive} onDragStart={onDragStart}>
          <div className={`church-slide variant-${slide.variant}`}>
            <ChurchSlideContent slide={slide} hideText={church.textCleared} font={church.style.font} />
          </div>
        </Positioned>
      ) : null}
      {lowerThird && church.elements.lowerThird.visible ? (
        <Positioned element={church.elements.lowerThird} interactive={interactive} onDragStart={onDragStart}>
          <article
            className={`church-lower-third variant-${church.elements.lowerThird.variant}`}
            style={{ "--church-accent": church.style.accentColor, fontFamily: `${church.style.font}, Arial, sans-serif` } as React.CSSProperties}
          >
            <h2>{lowerThird.title}</h2>
            {lowerThird.subtitle ? <p>{lowerThird.subtitle}</p> : null}
          </article>
        </Positioned>
      ) : null}
      {countdown && church.elements.countdown.visible ? (
        <Positioned element={church.elements.countdown} interactive={interactive} onDragStart={onDragStart}>
          <div
            className={`countdown-element variant-${church.elements.countdown.variant}`}
            style={{ "--church-accent": church.style.accentColor, fontFamily: `${church.style.font}, Arial, sans-serif` } as React.CSSProperties}
            role="timer"
            aria-label={`${countdown.title}: ${formatPackageTime(countdownSeconds)}`}
          >
            <span>{countdown.title}</span>
            <strong>{formatPackageTime(countdownSeconds)}</strong>
          </div>
        </Positioned>
      ) : null}
    </>
  );
}

function Positioned({
  element,
  children,
  interactive,
  onDragStart
}: {
  element: OverlayElementConfig;
  children: React.ReactNode;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <section
      className={`overlay-element ${interactive ? "is-interactive" : ""}`}
      data-element-id={element.id}
      style={placementStyle(element.placement)}
      onPointerDown={(event) => {
        if (interactive) onDragStart?.(element.id, event);
      }}
    >
      {children}
    </section>
  );
}

function FullMatchup({
  state,
  countdownSeconds,
  phase,
  textAnimationFields
}: {
  state: SoccerState;
  countdownSeconds: number;
  phase: ActiveOverlayPhase;
  textAnimationFields: TextAnimationFields;
}) {
  return (
    <article className={labOverlayClass("overlay-full-matchup", phase)} aria-label="Full page matchup">
      <PackageBackground enabled={state.soccerPackage.packageBackground} />
      <div className="full-panel">
        <div className={`match-kicker ${textUpdateClass(textAnimationFields, "event-title")}`} data-bind-event-title>
          <span className="match-label-shadow" aria-hidden="true" />
          <span>{state.gameTitle}</span>
        </div>
        <div className="full-teams">
          <span className="full-teams-shadow" aria-hidden="true" />
          <FullTeam team={state.home} side="home" textAnimationFields={textAnimationFields} />
          <div className="full-divider">
            <b className="full-countdown">{formatPackageTime(countdownSeconds)}</b>
          </div>
          <FullTeam team={state.away} side="away" textAnimationFields={textAnimationFields} />
        </div>
        <div className={`match-footer ${textUpdateClass(textAnimationFields, "production-name")}`} data-bind-production>
          <span className="match-label-shadow" aria-hidden="true" />
          <span>{state.productionName}</span>
        </div>
      </div>
    </article>
  );
}

function FullTeam({ team, side, textAnimationFields }: { team: SoccerState["home"]; side: "home" | "away"; textAnimationFields: TextAnimationFields }) {
  const nameField = side === "home" ? "home-name" : "away-name";
  const recordField = side === "home" ? "home-record" : "away-record";
  const logoField = side === "home" ? "home-logo" : "away-logo";
  return (
    <section className={`full-team ${side}`}>
      {side === "home" ? <TeamImage team={team} className={`team-logo ${textUpdateClass(textAnimationFields, logoField)}`} /> : null}
      <div className="team-copy">
        <span className={textUpdateClass(textAnimationFields, nameField)} data-bind-team>
          {team.fullName}
        </span>
        <small className={textUpdateClass(textAnimationFields, recordField)} data-bind-team>
          {formatRecord(team.record)}
        </small>
      </div>
      {side === "away" ? <TeamImage team={team} className={`team-logo ${textUpdateClass(textAnimationFields, logoField)}`} /> : null}
    </section>
  );
}

function LowerMatchup({
  state,
  countdownSeconds,
  phase,
  textAnimationFields
}: {
  state: SoccerState;
  countdownSeconds: number;
  phase: ActiveOverlayPhase;
  textAnimationFields: TextAnimationFields;
}) {
  return (
    <article className={labOverlayClass("overlay-lower-matchup", phase)} aria-label="Lower matchup">
      <div className="lower-shell">
        <div className={`lower-kicker ${textUpdateClass(textAnimationFields, "event-title")}`} data-bind-event-title>
          <span className="lower-kicker-shadow" aria-hidden="true" />
          <span>{state.gameTitle}</span>
        </div>
        <div className="lower-match-row">
          <span className="lower-row-shadow" aria-hidden="true" />
          <LowerTeam team={state.home} side="home" textAnimationFields={textAnimationFields} />
          <strong className="lower-match-center">
            <span className="lower-versus">VS</span>
            <span className="lower-match-countdown lower-countdown">
              <em>Countdown</em>
              <b>{formatPackageTime(countdownSeconds)}</b>
            </span>
          </strong>
          <LowerTeam team={state.away} side="away" textAnimationFields={textAnimationFields} />
        </div>
      </div>
    </article>
  );
}

function LowerTeam({ team, side, textAnimationFields }: { team: SoccerState["home"]; side: "home" | "away"; textAnimationFields: TextAnimationFields }) {
  const nameField = side === "home" ? "home-name" : "away-name";
  const recordField = side === "home" ? "home-record" : "away-record";
  const logoField = side === "home" ? "home-logo" : "away-logo";
  return (
    <section className={`lower-team ${side}`}>
      {side === "home" ? <TeamImage team={team} className={`team-logo ${textUpdateClass(textAnimationFields, logoField)}`} /> : null}
      <div>
        <b className={textUpdateClass(textAnimationFields, nameField)} data-bind-team>
          {team.fullName}
        </b>
        <span className={textUpdateClass(textAnimationFields, recordField)} data-bind-team>
          {formatRecord(team.record)}
        </span>
      </div>
      {side === "away" ? <TeamImage team={team} className={`team-logo ${textUpdateClass(textAnimationFields, logoField)}`} /> : null}
    </section>
  );
}

function LowerResult({
  state,
  countdownSeconds,
  phase,
  textAnimationFields
}: {
  state: SoccerState;
  countdownSeconds: number;
  phase: ActiveOverlayPhase;
  textAnimationFields: TextAnimationFields;
}) {
  return (
    <article className={labOverlayClass("overlay-lower-result", phase)} aria-label="Lower matchup with score">
      <div className="lower-shell">
        <div className={`lower-kicker ${textUpdateClass(textAnimationFields, "event-title")}`} data-bind-event-title>
          <span className="lower-kicker-shadow" aria-hidden="true" />
          <span>{state.gameTitle}</span>
        </div>
        <div className="lower-result-row">
          <span className="lower-row-shadow" aria-hidden="true" />
          <section className="lower-result-team lower-result-home">
            <TeamImage team={state.home} className={`team-logo ${textUpdateClass(textAnimationFields, "home-logo")}`} />
            <b className={textUpdateClass(textAnimationFields, "home-abbrev")} data-bind-team>
              {state.home.abbreviation}
            </b>
          </section>
          <strong className={`lower-result-score ${scoreUpdateClass(textAnimationFields, "home-score")}`} data-bind-score>
            {state.score.home}
          </strong>
          <div className="lower-result-state">
            <span>{state.soccerPackage.lowerResultState}</span>
            <b>{formatPackageTime(countdownSeconds)}</b>
            <em>Back in</em>
          </div>
          <strong className={`lower-result-score ${scoreUpdateClass(textAnimationFields, "away-score")}`} data-bind-score>
            {state.score.away}
          </strong>
          <section className="lower-result-team lower-result-away">
            <b className={textUpdateClass(textAnimationFields, "away-abbrev")} data-bind-team>
              {state.away.abbreviation}
            </b>
            <TeamImage team={state.away} className={`team-logo ${textUpdateClass(textAnimationFields, "away-logo")}`} />
          </section>
        </div>
      </div>
    </article>
  );
}

function LineupPanel({ state, phase, textAnimationFields }: { state: SoccerState; phase: ActiveOverlayPhase; textAnimationFields: TextAnimationFields }) {
  const team = state.soccerPackage.lineupTeam === "away" ? state.away : state.home;
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(team.roster.length / pageSize));
  const page = Math.min(totalPages - 1, Math.max(0, state.soccerPackage.lineupPage));
  const rows = team.roster.slice(page * pageSize, page * pageSize + pageSize);
  while (rows.length < pageSize) rows.push({ id: `blank-${rows.length}`, line: "", name: "", starter: false });
  return (
    <article className={labOverlayClass("overlay-lineup", phase)} aria-label="Lineup panel">
      <span className="lineup-shadow" aria-hidden="true" />
      <div className="lineup-head">
        <span className={textUpdateClass(textAnimationFields, "lineup-title")} data-bind-lineup-title>
          {team.fullName}
        </span>
        <TeamImage team={team} className={`team-logo lineup-logo ${textUpdateClass(textAnimationFields, "lineup-logo")}`} />
      </div>
      <ol className={`lineup-list ${textUpdateClass(textAnimationFields, "lineup-rows") ? "lineup-text-updated" : ""}`}>
        {rows.map((player) => (
          <li key={player.id}>
            <b>{player.number || ""}</b>
            <span>{player.name}</span>
          </li>
        ))}
      </ol>
      <small className="lineup-page">
        {page + 1} / {totalPages}
      </small>
    </article>
  );
}

function LabScorebug({
  state,
  now,
  phase,
  textAnimationFields
}: {
  state: SoccerState;
  now: number;
  phase: ActiveOverlayPhase;
  textAnimationFields: TextAnimationFields;
}) {
  const vertical = state.soccerPackage.scorebugLayout === "vertical";
  return (
    <article className={labOverlayClass("overlay-scorebug", phase, vertical ? "scorebug-vertical" : "scorebug-horizontal")} aria-label="Scorebug">
      <span className="scorebug-shadow" aria-hidden="true" />
      <div className={`bug-team ${textUpdateClass(textAnimationFields, "home-abbrev")}`} data-bind-team>
        {state.home.abbreviation}
      </div>
      <div className={`bug-score ${scoreUpdateClass(textAnimationFields, "home-score")}`} data-bind-score>
        {state.score.home}
      </div>
      <div className="bug-clock">
        <strong>{formatSoccerClock(state.clock, now)}</strong>
        <em>·</em>
        <span>{state.clock.periodLabel}</span>
      </div>
      <div className={`bug-score ${scoreUpdateClass(textAnimationFields, "away-score")}`} data-bind-score>
        {state.score.away}
      </div>
      <div className={`bug-team ${textUpdateClass(textAnimationFields, "away-abbrev")}`} data-bind-team>
        {state.away.abbreviation}
      </div>
    </article>
  );
}

function CountdownOverlay({ state, countdownSeconds, phase }: { state: SoccerState; countdownSeconds: number; phase: ActiveOverlayPhase }) {
  const small = state.soccerPackage.countdown.mode === "small";
  const cardRef = useRef<HTMLDivElement | null>(null);
  const previousLayoutRef = useRef<{ mode: SoccerState["soccerPackage"]["countdown"]["mode"]; rect: DOMRect } | null>(null);
  const layoutAnimationRef = useRef<Animation | null>(null);
  const label = state.soccerPackage.countdown.label.trim() || "Kickoff Countdown";

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const nextRect = card.getBoundingClientRect();
    const previousLayout = previousLayoutRef.current;
    layoutAnimationRef.current?.cancel();

    if (previousLayout?.mode === "full" && state.soccerPackage.countdown.mode === "small" && typeof card.animate === "function") {
      const deltaX = previousLayout.rect.left - nextRect.left;
      const deltaY = previousLayout.rect.top - nextRect.top;
      const scaleX = previousLayout.rect.width / Math.max(1, nextRect.width);
      const scaleY = previousLayout.rect.height / Math.max(1, nextRect.height);
      layoutAnimationRef.current = card.animate(
        [
          {
            transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
            transformOrigin: "top left"
          },
          {
            transform: "translate(0, 0) scale(1)",
            transformOrigin: "top left"
          }
        ],
        {
          duration: 680,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "both"
        }
      );
      layoutAnimationRef.current.onfinish = () => {
        layoutAnimationRef.current = null;
      };
    }

    previousLayoutRef.current = { mode: state.soccerPackage.countdown.mode, rect: nextRect };
    return () => {
      layoutAnimationRef.current?.cancel();
      layoutAnimationRef.current = null;
    };
  }, [state.soccerPackage.countdown.mode, state.soccerPackage.countdown.position]);

  return (
    <article
      className={labOverlayClass("overlay-countdown", phase, small ? `countdown-small position-${state.soccerPackage.countdown.position}` : "countdown-full")}
      aria-label="Countdown timer"
    >
      <PackageBackground enabled={!small && state.soccerPackage.packageBackground} />
      <div ref={cardRef} className="timer-card">
        <span className="timer-card-shadow" aria-hidden="true" />
        <span>{label}</span>
        <strong className="timer-value">{formatPackageTime(countdownSeconds)}</strong>
      </div>
    </article>
  );
}

function OneLineText({ state, phase, textAnimationFields }: { state: SoccerState; phase: ActiveOverlayPhase; textAnimationFields: TextAnimationFields }) {
  return (
    <article
      className={labOverlayClass("overlay-text-bug", phase, `one-line-text position-${state.soccerPackage.oneLinePosition}`)}
      aria-label="One line text bug"
    >
      <span className="text-bug-shadow" aria-hidden="true" />
      <div className={textUpdateClass(textAnimationFields, "one-line")} data-bind-text-one>
        <span>{state.soccerPackage.oneLineText}</span>
      </div>
    </article>
  );
}

function TwoLineText({ state, phase, textAnimationFields }: { state: SoccerState; phase: ActiveOverlayPhase; textAnimationFields: TextAnimationFields }) {
  return (
    <article
      className={labOverlayClass("overlay-text-bug", phase, `two-line-text position-${state.soccerPackage.twoLinePosition}`)}
      aria-label="Two line text bug"
    >
      <span className="text-bug-shadow" aria-hidden="true" />
      <div>
        <strong className={textUpdateClass(textAnimationFields, "two-line-a")} data-bind-text-two-a>
          {state.soccerPackage.twoLineTextA}
        </strong>
        <span className={textUpdateClass(textAnimationFields, "two-line-b")} data-bind-text-two-b>
          {state.soccerPackage.twoLineTextB}
        </span>
      </div>
    </article>
  );
}

function PackageBackground({ enabled }: { enabled: boolean }) {
  return enabled ? <div className="package-bg" aria-hidden="true" /> : null;
}

function TeamImage({ team, className }: { team: SoccerState["home"]; className: string }) {
  const crop = team.imageCrop || { x: 0, y: 0, zoom: 1 };
  return (
    <div
      className={className}
      data-bind-team-logo
      style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}
    >
      {team.logoUrl ? (
        <img
          src={mediaApi.mediaUrl(team.logoUrl)}
          alt=""
          style={{
            transform: `translate(${crop.x}px, ${crop.y}px) scale(${crop.zoom})`
          }}
        />
      ) : (
        <span>{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
      )}
    </div>
  );
}

function packageCountdownSeconds(countdown: SoccerState["soccerPackage"]["countdown"], now: number): number {
  if (!countdown.running || countdown.startedAtMs === null) return countdown.seconds;
  const elapsed = Math.max(0, Math.floor((now - countdown.startedAtMs) / 1000));
  return Math.max(0, countdown.seconds - elapsed);
}

function formatPackageTime(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const remainder = clamped % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function formatRecord(record: SoccerState["home"]["record"]): string {
  return `${record.wins}-${record.losses}-${record.draws}`;
}

function TemporaryGraphic({ graphic }: { graphic: ActiveGraphic }) {
  const className = `temporary-graphic graphic-${graphic.kind} variant-${graphic.variant}`;
  const showLineups = graphic.kind === "lineups";
  return (
    <section className={className} style={placementStyle(graphic.placement)}>
      <div className="graphic-label">{graphic.label || graphic.kind.replace("-", " ")}</div>
      <h2>{graphic.title}</h2>
      {graphic.subtitle ? <p>{graphic.subtitle}</p> : null}
      {showLineups ? <small>Starting XI</small> : null}
    </section>
  );
}

function isChurchManagedGraphic(graphic: ActiveGraphic): boolean {
  return graphic.kind === "countdown" || graphic.kind === "church-lower-third" || graphic.kind === "lower-third";
}

function placementStyle(placement: Placement): React.CSSProperties {
  return {
    left: placement.x,
    top: placement.y,
    width: placement.width,
    height: placement.height,
    transform: `scale(${placement.scale})`,
    transformOrigin: "top left"
  };
}

function isSoccerState(state: PresetState): state is SoccerState {
  return "score" in state && "clock" in state;
}

function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state;
}

export function getElementById(state: PresetState, elementId: string): OverlayElementConfig | undefined {
  if ("elements" in state && !Array.isArray(state.elements)) {
    return Object.values(state.elements as Record<string, OverlayElementConfig>).find((element) => element.id === elementId);
  }
  if ("elements" in state && Array.isArray(state.elements)) {
    return (state.elements as OverlayElementConfig[]).find((element) => element.id === elementId);
  }
  return undefined;
}

export function updateElementPlacement(state: PresetState, elementId: string, placement: Placement): PresetState {
  const copy = structuredClone(state) as PresetState;
  if ("elements" in copy && !Array.isArray(copy.elements)) {
    for (const element of Object.values(copy.elements as Record<string, OverlayElementConfig>)) {
      if (element.id === elementId) element.placement = placement;
    }
  }
  if ("elements" in copy && Array.isArray(copy.elements)) {
    for (const element of copy.elements as OverlayElementConfig[]) {
      if (element.id === elementId) element.placement = placement;
    }
  }
  return copy;
}
