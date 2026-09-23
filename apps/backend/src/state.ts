import {
  CHURCH_BACKGROUND_PRESETS,
  MAX_PRESET_STATE_BYTES,
  type ActiveGraphic,
  type ChurchState,
  type GraphicKind,
  type OverlayElementConfig,
  type Placement,
  type PresetState,
  type PresetType,
  type SoccerState,
  clockIsAtStop,
  churchOnAirSlide,
  createDefaultPresetState,
  createNewPresetState,
  defaultElement,
  makeId,
  normalizeChurchState,
  normalizeSoccerState,
  parseRoster,
  pauseClock,
  resetClock,
  startClock,
  withoutExpiredGraphics
} from "@openoverlay/shared";

export type PresetAction =
  | "home-score-plus"
  | "home-score-minus"
  | "away-score-plus"
  | "away-score-minus"
  | "clock-toggle"
  | "clock-reset"
  | "trigger-goal"
  | "trigger-yellow-card"
  | "trigger-red-card"
  | "trigger-substitution"
  | "trigger-halftime"
  | "trigger-full-time"
  | "trigger-lineups"
  | "trigger-sponsor"
  | "trigger-lower-third"
  | "trigger-countdown"
  | "show-overlay"
  | "hide-overlay"
  | "select-overlay"
  | "countdown-toggle"
  | "countdown-start"
  | "countdown-stop"
  | "countdown-reset"
  | "lineup-next"
  | "lineup-prev"
  | "clear";

const presetActions = new Set<PresetAction>([
  "home-score-plus",
  "home-score-minus",
  "away-score-plus",
  "away-score-minus",
  "clock-toggle",
  "clock-reset",
  "trigger-goal",
  "trigger-yellow-card",
  "trigger-red-card",
  "trigger-substitution",
  "trigger-halftime",
  "trigger-full-time",
  "trigger-lineups",
  "trigger-sponsor",
  "trigger-lower-third",
  "trigger-countdown",
  "show-overlay",
  "hide-overlay",
  "select-overlay",
  "countdown-toggle",
  "countdown-start",
  "countdown-stop",
  "countdown-reset",
  "lineup-next",
  "lineup-prev",
  "clear"
]);

const graphicPayloadActions = new Set<PresetAction>([
  "trigger-goal",
  "trigger-yellow-card",
  "trigger-red-card",
  "trigger-substitution",
  "trigger-halftime",
  "trigger-full-time",
  "trigger-lineups",
  "trigger-sponsor",
  "trigger-lower-third",
  "trigger-countdown"
]);
const soccerPayloadlessActions = new Set<PresetAction>([
  "home-score-plus",
  "home-score-minus",
  "away-score-plus",
  "away-score-minus",
  "clock-toggle",
  "clock-reset",
  "countdown-toggle",
  "countdown-start",
  "countdown-stop",
  "countdown-reset",
  "lineup-next",
  "lineup-prev"
]);
const overlayPayloadActions = new Set<PresetAction>(["show-overlay", "hide-overlay", "select-overlay"]);
const churchCountdownPayloadActions = new Set<PresetAction>(["trigger-countdown", "countdown-toggle", "countdown-start"]);
const graphicPayloadFields = new Set(["title", "subtitle", "label", "team", "variant", "durationSeconds"]);
const MAX_ACTION_PAYLOAD_BYTES = 2 * 1024;
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const graphicKinds = new Set<GraphicKind>([
  "goal",
  "yellow-card",
  "red-card",
  "substitution",
  "injury",
  "halftime",
  "matchup-full",
  "matchup-lower",
  "lineups",
  "sponsor",
  "lower-third",
  "countdown",
  "fullscreen",
  "blank",
  "team",
  "both-teams",
  "church-slide",
  "church-lower-third"
]);
const soccerTextAnimationFields = [
  "event-title",
  "production-name",
  "home-name",
  "away-name",
  "home-abbrev",
  "away-abbrev",
  "home-record",
  "away-record",
  "home-logo",
  "away-logo",
  "home-score",
  "away-score",
  "lineup-title",
  "lineup-logo",
  "lineup-rows",
  "one-line",
  "two-line-a",
  "two-line-b"
] as const;

export class PresetStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetStateValidationError";
  }
}

export class PresetActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetActionValidationError";
  }
}

export function isPresetAction(value: string): value is PresetAction {
  return presetActions.has(value as PresetAction);
}

export function isSoccerState(state: unknown): state is SoccerState {
  return isPlainObject(state) && isPlainObject(state.home) && isPlainObject(state.away) && isPlainObject(state.clock) && isPlainObject(state.score);
}

export function isChurchState(state: unknown): state is ChurchState {
  return isPlainObject(state) && Array.isArray(state.slides) && typeof state.serviceTitle === "string";
}

export function materializeState(state: PresetState, nowMs = Date.now()): PresetState {
  let pruned = withoutExpiredGraphics(state as PresetState & { activeGraphics: ActiveGraphic[] }, nowMs);
  if (isSoccerState(pruned)) {
    pruned = normalizeSoccerState(pruned);
    if (pruned.clock.running && clockIsAtStop(pruned.clock, nowMs)) {
      pruned = {
        ...pruned,
        clock: pauseClock(pruned.clock, nowMs)
      };
    }
    const countdown = pruned.soccerPackage.countdown;
    if (countdown.running && countdown.startedAtMs !== null) {
      const elapsed = Math.max(0, Math.floor((nowMs - countdown.startedAtMs) / 1000));
      if (countdown.seconds - elapsed <= 0) {
        pruned = {
          ...pruned,
          soccerPackage: {
            ...pruned.soccerPackage,
            countdown: {
              ...countdown,
              seconds: 0,
              running: false,
              startedAtMs: null
            }
          }
        };
      }
    }
  } else if (isChurchState(pruned)) {
    pruned = normalizeChurchState(pruned);
  }
  return pruned;
}

export function mergePresetState(existing: PresetState, patch: Partial<PresetState>): PresetState {
  assertSafeJsonValue(patch);
  const next = deepMerge(existing, patch) as PresetState;
  const type: PresetType = isSoccerState(existing) ? "soccer" : isChurchState(existing) ? "church" : "custom";
  return validatePresetState(type, stateName(existing), next);
}

export function applyAction(state: PresetState, action: PresetAction, payload: Record<string, unknown> = {}, nowMs = Date.now()): PresetState {
  if (!isPresetAction(action)) throw new PresetActionValidationError("Unknown preset action");
  const current = materializeState(state, nowMs);
  const validatedPayload = validatePresetActionPayload(current, action, payload);
  let next: PresetState;
  if (action === "clear") {
    next = clearTemporaryGraphics(current);
  } else if (isSoccerState(current)) {
    next = applySoccerAction(current, action, validatedPayload, nowMs);
  } else if (isChurchState(current)) {
    next = applyChurchAction(current, action, validatedPayload, nowMs);
  } else {
    throw new PresetActionValidationError("Action is not supported for this preset type");
  }

  const type: PresetType = isSoccerState(next) ? "soccer" : isChurchState(next) ? "church" : "custom";
  try {
    return validatePresetState(type, stateName(next), next);
  } catch (error) {
    if (error instanceof PresetStateValidationError) throw new PresetActionValidationError(error.message);
    throw error;
  }
}

export function validatePresetActionPayload(state: PresetState, action: PresetAction, payload: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(payload)) throw new PresetActionValidationError("Action payload must be a JSON object");
  try {
    assertSafeJsonValue(payload);
  } catch (error) {
    if (error instanceof PresetStateValidationError) {
      throw new PresetActionValidationError(error.message.replace(/^state/, "payload"));
    }
    throw error;
  }

  const allowedFields = allowedPayloadFields(state, action);
  for (const key of Object.keys(payload)) {
    if (!allowedFields.has(key)) throw new PresetActionValidationError(`Unexpected field for ${action}: ${key}`);
  }

  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "title" || key === "subtitle") {
      validated[key] = validatedTextField(action, key, value, 500);
    } else if (key === "label") {
      validated[key] = validatedTextField(action, key, value, 200);
    } else if (key === "team") {
      if (value !== "home" && value !== "away" && value !== "both" && value !== "none") {
        throw new PresetActionValidationError(`team must be home, away, both, or none for ${action}`);
      }
      if ((action === "trigger-goal" || action === "trigger-lineups") && value !== "home" && value !== "away") {
        throw new PresetActionValidationError(`team must be home or away for ${action}`);
      }
      validated[key] = value;
    } else if (key === "variant") {
      if (value !== "clean" && value !== "glass" && value !== "stripe" && value !== "broadcast" && value !== "neon") {
        throw new PresetActionValidationError(`variant is invalid for ${action}`);
      }
      validated[key] = value;
    } else if (key === "durationSeconds") {
      const minimum = (isChurchState(state) && churchCountdownPayloadActions.has(action)) || action === "countdown-start" ? 1 : 0;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 3_600) {
        throw new PresetActionValidationError(`durationSeconds must be an integer from ${minimum} to 3600 for ${action}`);
      }
      validated[key] = value;
    } else if (key === "overlay") {
      if (!isLabOverlay(value)) throw new PresetActionValidationError(`overlay is invalid for ${action}`);
      validated[key] = value;
    }
  }

  const payloadJson = JSON.stringify(validated);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_ACTION_PAYLOAD_BYTES) {
    throw new PresetActionValidationError(`Action payload exceeds ${MAX_ACTION_PAYLOAD_BYTES} bytes`);
  }
  return validated;
}

function allowedPayloadFields(state: PresetState, action: PresetAction): ReadonlySet<string> {
  if (action === "clear") return new Set<string>();
  if (isSoccerState(state)) {
    if (graphicPayloadActions.has(action)) return graphicPayloadFields;
    if (overlayPayloadActions.has(action)) return new Set(["overlay"]);
    if (action === "countdown-start") return new Set(["durationSeconds"]);
    if (soccerPayloadlessActions.has(action)) return new Set<string>();
  } else if (isChurchState(state)) {
    if (action === "trigger-lower-third" || churchCountdownPayloadActions.has(action)) return graphicPayloadFields;
    if (action === "countdown-stop" || action === "countdown-reset") return new Set<string>();
  }
  throw new PresetActionValidationError("Action is not supported for this preset type");
}

function validatedTextField(action: PresetAction, field: string, value: unknown, maximumLength: number): string {
  if (typeof value !== "string") throw new PresetActionValidationError(`${field} must be a string for ${action}`);
  if (value.length > maximumLength) throw new PresetActionValidationError(`${field} is too long for ${action}`);
  return value;
}

export function cloneStateForShare(state: PresetState): PresetState {
  return JSON.parse(JSON.stringify(state)) as PresetState;
}

export function ensurePresetState(type: "soccer" | "church" | "custom", name: string, state?: PresetState): PresetState {
  return state === undefined ? createNewPresetState(type, name) : validatePresetState(type, name, state);
}

export function validatePresetState(type: PresetType, name: string, value: unknown): PresetState {
  assertSafeJsonValue(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PRESET_STATE_BYTES) throw new PresetStateValidationError("State is too large");
  const template = createDefaultPresetState(type, name);
  assertMatchesTemplate(value, template, "state");
  let cloned = structuredClone(value) as PresetState;
  if (type === "soccer") {
    if (!isSoccerState(cloned)) throw new PresetStateValidationError("State does not match soccer preset type");
    // rosterText is authoritative. Canonicalize it before enforcing the
    // roster limit so a small/stale roster array cannot bypass validation.
    cloned.home.roster = parseRoster(cloned.home.rosterText);
    cloned.away.roster = parseRoster(cloned.away.rosterText);
  }
  if (type === "church" && isChurchState(cloned)) cloned = normalizeChurchState(cloned);
  assertDomainConstraints(type, cloned);
  if (type === "soccer") {
    cloned = normalizeSoccerState(cloned as SoccerState);
  }
  if (type === "church" && !isChurchState(cloned)) {
    throw new PresetStateValidationError("State does not match church preset type");
  }
  if (type === "custom" && (isSoccerState(cloned) || isChurchState(cloned))) {
    throw new PresetStateValidationError("State does not match custom preset type");
  }
  // Canonicalization can add derived fields. Enforce the persistence boundary
  // against the object that will actually be stored, not only the input.
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > MAX_PRESET_STATE_BYTES) throw new PresetStateValidationError("State is too large");
  return cloned;
}

export function readStoredPresetState(row: { type: PresetType; name: string; state_json: string }): { state: PresetState; recovered: boolean } {
  try {
    return { state: validatePresetState(row.type, row.name, JSON.parse(row.state_json) as unknown), recovered: false };
  } catch {
    return { state: createOffAirRecoveryState(row.type, row.name), recovered: true };
  }
}

function createOffAirRecoveryState(type: PresetType, name: string): PresetState {
  const state = createNewPresetState(type, name);
  state.activeGraphics = [];
  if (isSoccerState(state)) {
    state.soccerPackage.activeOverlay = null;
    state.soccerPackage.countdown = { ...state.soccerPackage.countdown, running: false, startedAtMs: null };
    state.clock = { ...state.clock, running: false, startedAtMs: null };
    for (const element of Object.values(state.elements)) element.visible = false;
  } else if (isChurchState(state)) {
    state.onAirSlide = null;
    state.stageMessage = undefined;
    for (const element of Object.values(state.elements)) element.visible = false;
  } else {
    for (const element of state.elements) element.visible = false;
  }
  return state;
}

export function publicOverlayState(state: PresetState): PresetState {
  if (!isChurchState(state)) return state;
  const displayed = state.elements.fullscreenSlide.visible ? churchOnAirSlide(state) : null;
  const slide: ChurchState["slides"][number] | null = displayed
    ? {
        id: displayed.id,
        title: displayed.title,
        type: displayed.type,
        text: displayed.text,
        mediaUrl: displayed.mediaUrl,
        section: displayed.section,
        backgroundColor: displayed.backgroundColor,
        textColor: displayed.textColor,
        variant: displayed.variant,
        label: displayed.label,
        reference: displayed.reference,
        fontSize: displayed.fontSize,
        textAlign: displayed.textAlign,
        backgroundDim: displayed.backgroundDim,
        backgroundPreset: displayed.backgroundPreset,
        backgroundMotion: displayed.backgroundMotion
      }
    : null;
  const publicElement = (element: OverlayElementConfig): OverlayElementConfig => ({
    id: element.id,
    visible: element.visible,
    placement: {
      x: element.placement.x,
      y: element.placement.y,
      width: element.placement.width,
      height: element.placement.height,
      scale: element.placement.scale,
      preset: element.placement.preset
    },
    variant: element.variant,
    accentColor: element.accentColor,
    font: element.font
  });
  return {
    serviceTitle: "",
    sections: slide ? [slide.section] : [],
    slides: slide ? [slide] : [],
    selectedSlideId: slide?.id,
    onAirSlide: slide,
    blackout: state.blackout,
    textCleared: state.textCleared,
    style: {
      font: state.style.font,
      accentColor: state.style.accentColor,
      backgroundMode: state.style.backgroundMode,
      backgroundColor: state.style.backgroundColor,
      theme: state.style.theme,
      animation: state.style.animation
    },
    elements: {
      lowerThird: publicElement(state.elements.lowerThird),
      countdown: publicElement(state.elements.countdown),
      fullscreenSlide: publicElement(state.elements.fullscreenSlide)
    },
    activeGraphics: state.activeGraphics
      .filter((graphic) => graphic.kind === "countdown" || graphic.kind === "lower-third" || graphic.kind === "church-lower-third")
      .map((graphic) => ({
        id: graphic.id,
        kind: graphic.kind,
        title: graphic.title,
        subtitle: graphic.subtitle,
        label: graphic.label,
        team: graphic.team,
        variant: graphic.variant,
        placement: {
          x: graphic.placement.x,
          y: graphic.placement.y,
          width: graphic.placement.width,
          height: graphic.placement.height,
          scale: graphic.placement.scale,
          preset: graphic.placement.preset
        },
        startedAtMs: graphic.startedAtMs,
        durationMs: graphic.durationMs,
        expiresAtMs: graphic.expiresAtMs
      }))
  };
}

function applySoccerAction(state: SoccerState, action: PresetAction, payload: Record<string, unknown>, nowMs: number): SoccerState {
  const current = normalizeSoccerState(state);
  const next: SoccerState = { ...current, score: { ...current.score }, clock: { ...current.clock }, soccerPackage: structuredClone(current.soccerPackage) };

  if (action === "home-score-plus") next.score.home += 1;
  if (action === "home-score-minus") next.score.home = Math.max(0, next.score.home - 1);
  if (action === "away-score-plus") next.score.away += 1;
  if (action === "away-score-minus") next.score.away = Math.max(0, next.score.away - 1);
  if (action === "home-score-plus" || action === "home-score-minus") next.soccerPackage.textAnimation = { id: nowMs, fields: ["home-score"] };
  if (action === "away-score-plus" || action === "away-score-minus") next.soccerPackage.textAnimation = { id: nowMs, fields: ["away-score"] };

  if (action === "clock-toggle") {
    next.clock = next.clock.running ? pauseClock(next.clock, nowMs) : startClock(next.clock, nowMs);
    if (next.clock.running) {
      next.soccerPackage.activeOverlay = "scorebug";
      next.soccerPackage.selectedOverlay = "scorebug";
    }
  }

  if (action === "clock-reset") {
    next.clock = resetClock(next.clock);
  }

  const lowerPlacement = next.elements.lowerThird.placement;
  const fullscreenPlacement = next.elements.fullscreen.placement;

  if (action === "trigger-goal") {
    const team = payload.team === "away" ? "away" : "home";
    const teamName = team === "away" ? next.away.shortName : next.home.shortName;
    return withToggledGraphic(
      next,
      makeGraphic("goal", textPayload(payload.title, "GOAL"), textPayload(payload.subtitle, teamName), fullscreenPlacement, { ...payload, team }, nowMs)
    );
  }
  if (action === "trigger-yellow-card") {
    return withToggledGraphic(
      next,
      makeGraphic("yellow-card", textPayload(payload.title, "Yellow Card"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs)
    );
  }
  if (action === "trigger-red-card") {
    return withToggledGraphic(
      next,
      makeGraphic("red-card", textPayload(payload.title, "Red Card"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs)
    );
  }
  if (action === "trigger-substitution") {
    return withToggledGraphic(
      next,
      makeGraphic("substitution", textPayload(payload.title, "Substitution"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs)
    );
  }
  if (action === "trigger-halftime") {
    return withToggledGraphic(
      next,
      makeGraphic(
        "halftime",
        textPayload(payload.title, "Halftime"),
        `${next.home.shortName} ${next.score.home} - ${next.score.away} ${next.away.shortName}`,
        fullscreenPlacement,
        payload,
        nowMs
      )
    );
  }
  if (action === "trigger-full-time") {
    return withToggledGraphic(
      next,
      makeGraphic(
        "fullscreen",
        textPayload(payload.title, "Full Time"),
        `${next.home.shortName} ${next.score.home} - ${next.score.away} ${next.away.shortName}`,
        fullscreenPlacement,
        payload,
        nowMs
      )
    );
  }
  if (action === "trigger-lineups") {
    const team = payload.team === "away" ? next.away : next.home;
    const roster = team.roster
      .slice(0, 11)
      .map((player) => (player.number ? `#${player.number} ${player.name}` : player.name))
      .join("  ·  ");
    return withToggledGraphic(
      next,
      makeGraphic("lineups", textPayload(payload.title, `${team.shortName} Lineup`), textPayload(payload.subtitle, roster), fullscreenPlacement, payload, nowMs)
    );
  }
  if (action === "trigger-sponsor") {
    return withToggledGraphic(
      next,
      makeGraphic("sponsor", textPayload(payload.title, "Sponsor"), textPayload(payload.subtitle, ""), next.elements.sponsorBug.placement, payload, nowMs)
    );
  }
  if (action === "trigger-lower-third") {
    return withToggledGraphic(
      next,
      makeGraphic("lower-third", textPayload(payload.title, "Lower Third"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs)
    );
  }
  if (action === "trigger-countdown") {
    next.soccerPackage = { ...next.soccerPackage, activeOverlay: "countdown-timer", selectedOverlay: "countdown-timer" };
    next.soccerPackage.countdown = startPackageCountdown(next.soccerPackage.countdown, nowMs);
    return withToggledGraphic(
      next,
      makeGraphic(
        "countdown",
        textPayload(payload.title, "Countdown"),
        textPayload(payload.subtitle, "Next segment"),
        next.elements.countdown.placement,
        payload,
        nowMs
      )
    );
  }

  if (action === "show-overlay" || action === "select-overlay") {
    const overlay = typeof payload.overlay === "string" ? payload.overlay : undefined;
    if (isLabOverlay(overlay)) {
      next.soccerPackage = { ...next.soccerPackage, activeOverlay: overlay, selectedOverlay: overlay };
    }
  }

  if (action === "hide-overlay") {
    const overlay = typeof payload.overlay === "string" ? payload.overlay : undefined;
    next.soccerPackage = {
      ...next.soccerPackage,
      activeOverlay: overlay && next.soccerPackage.activeOverlay !== overlay ? next.soccerPackage.activeOverlay : null,
      selectedOverlay: isLabOverlay(overlay) ? overlay : next.soccerPackage.selectedOverlay
    };
  }

  if (action === "countdown-toggle" || action === "countdown-start") {
    next.soccerPackage = { ...next.soccerPackage, activeOverlay: "countdown-timer", selectedOverlay: "countdown-timer" };
    if (action === "countdown-start" && typeof payload.durationSeconds === "number") {
      next.soccerPackage.countdown = {
        ...next.soccerPackage.countdown,
        seconds: payload.durationSeconds,
        resetSeconds: payload.durationSeconds,
        running: false,
        startedAtMs: null
      };
    }
    next.soccerPackage.countdown = startPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-toggle" && state.soccerPackage?.countdown?.running) {
    next.soccerPackage.countdown = stopPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-stop") {
    next.soccerPackage.countdown = stopPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-reset") {
    next.soccerPackage.countdown = {
      ...next.soccerPackage.countdown,
      seconds: next.soccerPackage.countdown.resetSeconds,
      running: false,
      startedAtMs: null
    };
  }

  if (action === "lineup-next" || action === "lineup-prev") {
    const team = next.soccerPackage.lineupTeam === "away" ? next.away : next.home;
    const totalPages = Math.max(1, Math.ceil(team.roster.length / 6));
    const step = action === "lineup-next" ? 1 : -1;
    next.soccerPackage.lineupPage = (next.soccerPackage.lineupPage + step + totalPages) % totalPages;
    next.soccerPackage.activeOverlay = "lineup-panel";
    next.soccerPackage.selectedOverlay = "lineup-panel";
  }

  return next;
}

function applyChurchAction(state: ChurchState, action: PresetAction, payload: Record<string, unknown>, nowMs: number): ChurchState {
  if (action === "trigger-lower-third") {
    const selectedSlide = state.slides.find((slide) => slide.id === state.selectedSlideId);
    const lowerThirdPayload = { durationSeconds: 0, ...payload };
    const graphic = makeGraphic(
      "church-lower-third",
      textPayload(payload.title, selectedSlide?.title || state.serviceTitle),
      textPayload(payload.subtitle, selectedSlide?.text || ""),
      state.elements.lowerThird.placement,
      lowerThirdPayload,
      nowMs
    );
    return { ...state, activeGraphics: toggleGraphic(state.activeGraphics, graphic) };
  }

  if (action === "countdown-stop" || action === "countdown-reset") {
    return { ...state, activeGraphics: state.activeGraphics.filter((graphic) => graphic.kind !== "countdown") };
  }

  if (action === "trigger-countdown" || action === "countdown-toggle" || action === "countdown-start") {
    const existing = state.activeGraphics.find((graphic) => graphic.kind === "countdown");
    if (existing && action !== "countdown-start") {
      return { ...state, activeGraphics: state.activeGraphics.filter((graphic) => graphic.kind !== "countdown") };
    }
    if (existing) return state;

    const durationSeconds = payload.durationSeconds === undefined ? 5 * 60 : payload.durationSeconds;
    if (typeof durationSeconds !== "number" || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3_600) {
      throw new PresetActionValidationError("durationSeconds must be an integer from 1 to 3600 for church countdowns");
    }
    const countdownPayload = { ...payload, durationSeconds };
    const graphic = makeGraphic(
      "countdown",
      textPayload(payload.title, "Service begins in"),
      textPayload(payload.subtitle, ""),
      state.elements.countdown.placement,
      countdownPayload,
      nowMs
    );
    return { ...state, activeGraphics: [...state.activeGraphics.filter((item) => item.kind !== "countdown"), graphic] };
  }

  throw new PresetActionValidationError("Action is not supported for this preset type");
}

function isLabOverlay(value: unknown): value is SoccerState["soccerPackage"]["selectedOverlay"] {
  return (
    typeof value === "string" &&
    ["full-matchup", "lower-matchup", "lower-result", "lineup-panel", "scorebug", "countdown-timer", "one-line-text", "two-line-text"].includes(value)
  );
}

function startPackageCountdown(countdown: SoccerState["soccerPackage"]["countdown"], nowMs: number): SoccerState["soccerPackage"]["countdown"] {
  if (countdown.running) return countdown;
  return {
    ...countdown,
    seconds: countdown.seconds <= 0 ? countdown.resetSeconds : countdown.seconds,
    running: true,
    startedAtMs: nowMs
  };
}

function stopPackageCountdown(countdown: SoccerState["soccerPackage"]["countdown"], nowMs: number): SoccerState["soccerPackage"]["countdown"] {
  if (!countdown.running || countdown.startedAtMs === null) return { ...countdown, running: false, startedAtMs: null };
  const elapsed = Math.max(0, Math.floor((nowMs - countdown.startedAtMs) / 1000));
  return {
    ...countdown,
    seconds: Math.max(0, countdown.seconds - elapsed),
    running: false,
    startedAtMs: null
  };
}

function toggleGraphic(activeGraphics: ActiveGraphic[], graphic: ActiveGraphic): ActiveGraphic[] {
  const activeIndex = activeGraphics.findIndex((candidate) => candidate.kind === graphic.kind);
  if (activeIndex >= 0) {
    return activeGraphics.filter((_, index) => index !== activeIndex);
  }
  return [...activeGraphics, graphic];
}

function withToggledGraphic(state: SoccerState, graphic: ActiveGraphic): SoccerState {
  return { ...state, activeGraphics: toggleGraphic(state.activeGraphics, graphic) };
}

function clearTemporaryGraphics<T extends PresetState>(state: T): T {
  if (isSoccerState(state)) {
    return {
      ...state,
      soccerPackage: {
        ...normalizeSoccerState(state).soccerPackage,
        activeOverlay: null,
        countdown: { ...normalizeSoccerState(state).soccerPackage.countdown, running: false, startedAtMs: null }
      },
      activeGraphics: []
    };
  }
  if (isChurchState(state)) {
    return {
      ...state,
      onAirSlide: null,
      blackout: false,
      textCleared: false,
      elements: { ...state.elements, fullscreenSlide: { ...state.elements.fullscreenSlide, visible: false } },
      activeGraphics: []
    };
  }
  return {
    ...state,
    activeGraphics: []
  };
}

function makeGraphic(kind: GraphicKind, title: string, subtitle: string, placement: Placement, payload: Record<string, unknown>, nowMs: number): ActiveGraphic {
  const durationSeconds = payload.durationSeconds === undefined ? 5 : payload.durationSeconds;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 0 ||
    durationSeconds > 3_600
  ) {
    throw new PresetActionValidationError("durationSeconds must be an integer from 0 to 3600");
  }
  const durationMs = Math.max(1, durationSeconds) * 1000;
  return {
    id: makeId("graphic"),
    kind,
    title,
    subtitle,
    label: typeof payload.label === "string" ? payload.label.slice(0, 200) : undefined,
    team: payload.team === "home" || payload.team === "away" || payload.team === "both" || payload.team === "none" ? payload.team : undefined,
    variant:
      payload.variant === "clean" ||
      payload.variant === "glass" ||
      payload.variant === "stripe" ||
      payload.variant === "broadcast" ||
      payload.variant === "neon"
        ? payload.variant
        : "broadcast",
    placement,
    startedAtMs: nowMs,
    durationMs,
    expiresAtMs: payload.durationSeconds === 0 ? null : nowMs + durationMs,
    payload
  };
}

function textPayload(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : fallback;
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source ?? target;
  const output: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (forbiddenObjectKeys.has(key)) throw new PresetStateValidationError(`Unsafe state key: ${key}`);
    output[key] = isPlainObject(value) && isPlainObject(output[key]) ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stateName(state: PresetState): string {
  if (isSoccerState(state)) return state.gameTitle;
  if (isChurchState(state)) return state.serviceTitle;
  return state.title;
}

function assertSafeJsonValue(value: unknown, path = "state", depth = 0): void {
  if (depth > 32) throw new PresetStateValidationError(`${path} is nested too deeply`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new PresetStateValidationError(`${path} must be finite`);
  if (typeof value === "string" && value.length > 100_000) throw new PresetStateValidationError(`${path} is too long`);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new PresetStateValidationError(`${path} has too many items`);
    value.forEach((item, index) => assertSafeJsonValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenObjectKeys.has(key)) throw new PresetStateValidationError(`Unsafe state key: ${key}`);
    assertSafeJsonValue(child, `${path}.${key}`, depth + 1);
  }
}

function assertMatchesTemplate(value: unknown, template: unknown, path: string): void {
  if (path === "state.soccerPackage.activeOverlay" && value === null) return;
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new PresetStateValidationError(`${path} must be an array`);
    if (path.endsWith("activeGraphics")) {
      value.forEach((graphic, index) => assertActiveGraphic(graphic, `${path}[${index}]`));
      return;
    }
    if (template.length > 0) value.forEach((item, index) => assertMatchesTemplate(item, template[0], `${path}[${index}]`));
    return;
  }
  if (isPlainObject(template)) {
    if (!isPlainObject(value)) throw new PresetStateValidationError(`${path} must be an object`);
    for (const [key, childTemplate] of Object.entries(template)) {
      if (!Object.hasOwn(value, key)) {
        if (path === "state" && key === "selectedSlideId") continue;
        throw new PresetStateValidationError(`${path}.${key} is required`);
      }
      assertMatchesTemplate(value[key], childTemplate, `${path}.${key}`);
    }
    return;
  }
  if (template === null) {
    if (value !== null && !(typeof value === "number" && Number.isFinite(value))) {
      throw new PresetStateValidationError(`${path} must be null or a finite number`);
    }
    return;
  }
  if (typeof value !== typeof template) throw new PresetStateValidationError(`${path} has an invalid type`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new PresetStateValidationError(`${path} must be finite`);
}

function assertActiveGraphic(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new PresetStateValidationError(`${path} must be an object`);
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.kind !== "string" || !graphicKinds.has(value.kind as GraphicKind)) {
    throw new PresetStateValidationError(`${path} has invalid identity fields`);
  }
  if (!isPlainObject(value.placement)) throw new PresetStateValidationError(`${path}.placement must be an object`);
  for (const field of ["x", "y", "width", "height", "scale"] as const) {
    if (typeof value.placement[field] !== "number" || !Number.isFinite(value.placement[field]))
      throw new PresetStateValidationError(`${path}.placement.${field} must be finite`);
  }
  if (
    typeof value.variant !== "string" ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    (value.expiresAtMs !== null && (typeof value.expiresAtMs !== "number" || !Number.isFinite(value.expiresAtMs)))
  ) {
    throw new PresetStateValidationError(`${path} has invalid timing or style fields`);
  }
  assertOneOf(value.variant, ["clean", "glass", "stripe", "broadcast", "neon"], `${path}.variant`);
  assertBoundedString(value.id as string, `${path}.id`, 200);
  assertBoundedString(value.title as string, `${path}.title`, 500);
  if (value.subtitle !== undefined) assertBoundedString(value.subtitle as string, `${path}.subtitle`, 1_000);
  if (value.label !== undefined) assertBoundedString(value.label as string, `${path}.label`, 200);
  if (value.team !== undefined) assertOneOf(value.team, ["home", "away", "both", "none"], `${path}.team`);
  if (value.payload !== undefined && !isPlainObject(value.payload)) {
    throw new PresetStateValidationError(`${path}.payload must be an object`);
  }
  if ((value.durationMs as number) > 3_600_000) throw new PresetStateValidationError(`${path}.durationMs is out of range`);
  assertPlacement(value.placement, `${path}.placement`);
}

function assertDomainConstraints(type: PresetType, state: PresetState): void {
  assertStyle(state.style, "state.style");
  if (state.activeGraphics.length > 100) throw new PresetStateValidationError("state.activeGraphics has too many items");
  for (const graphic of state.activeGraphics) assertActiveGraphic(graphic, "state.activeGraphics[]");
  if (type === "soccer") {
    if (!isSoccerState(state)) throw new PresetStateValidationError("State does not match soccer preset type");
    for (const [path, value] of [
      ["state.score.home", state.score.home],
      ["state.score.away", state.score.away],
      ["state.stats.shots.home", state.stats.shots.home],
      ["state.stats.shots.away", state.stats.shots.away],
      ["state.stats.fouls.home", state.stats.fouls.home],
      ["state.stats.fouls.away", state.stats.fouls.away],
      ["state.stats.cards.home", state.stats.cards.home],
      ["state.stats.cards.away", state.stats.cards.away],
      ["state.clock.baseSeconds", state.clock.baseSeconds],
      ["state.clock.resetSeconds", state.clock.resetSeconds],
      ["state.clock.stopAtSeconds", state.clock.stopAtSeconds],
      ["state.clock.stoppageMinutes", state.clock.stoppageMinutes],
      ["state.soccerPackage.countdown.seconds", state.soccerPackage.countdown.seconds],
      ["state.soccerPackage.countdown.resetSeconds", state.soccerPackage.countdown.resetSeconds],
      ["state.soccerPackage.lineupPage", state.soccerPackage.lineupPage]
    ] as Array<[string, number]>)
      assertNonNegativeInteger(value, path, 1_000_000);
    assertOneOf(state.clock.mode, ["up", "down"], "state.clock.mode");
    assertOneOf(state.soccerPackage.overlayPackage, ["rounded", "classic"], "state.soccerPackage.overlayPackage");
    if (state.soccerPackage.activeOverlay !== null) assertOneOf(state.soccerPackage.activeOverlay, labOverlays, "state.soccerPackage.activeOverlay");
    assertOneOf(state.soccerPackage.selectedOverlay, labOverlays, "state.soccerPackage.selectedOverlay");
    assertOneOf(state.soccerPackage.surface, ["pitch", "checker", "studio"], "state.soccerPackage.surface");
    assertOneOf(state.soccerPackage.scorebugLayout, ["horizontal", "vertical"], "state.soccerPackage.scorebugLayout");
    assertOneOf(state.soccerPackage.lowerResultState, ["HALF", "FINAL"], "state.soccerPackage.lowerResultState");
    assertOneOf(state.soccerPackage.countdown.mode, ["full", "small"], "state.soccerPackage.countdown.mode");
    assertOneOf(state.soccerPackage.lineupTeam, ["home", "away"], "state.soccerPackage.lineupTeam");
    if (state.soccerPackage.textAnimation !== undefined) {
      assertSoccerTextAnimation(state.soccerPackage.textAnimation, "state.soccerPackage.textAnimation");
    }
    if (state.soccerPackage.packageBackgroundOpacity < 0 || state.soccerPackage.packageBackgroundOpacity > 1)
      throw new PresetStateValidationError("state.soccerPackage.packageBackgroundOpacity must be between 0 and 1");
    if (state.soccerPackage.scorebugWidth < 44 || state.soccerPackage.scorebugWidth > 82)
      throw new PresetStateValidationError("state.soccerPackage.scorebugWidth must be between 44 and 82");
    if (state.clock.running && (!Number.isSafeInteger(state.clock.startedAtMs) || (state.clock.startedAtMs ?? 0) <= 0))
      throw new PresetStateValidationError("Running match clock needs a valid start timestamp");
    if (
      state.soccerPackage.countdown.running &&
      (!Number.isSafeInteger(state.soccerPackage.countdown.startedAtMs) || (state.soccerPackage.countdown.startedAtMs ?? 0) <= 0)
    )
      throw new PresetStateValidationError("Running countdown needs a valid start timestamp");
    assertBoundedString(state.gameTitle, "state.gameTitle", 200);
    assertBoundedString(state.productionName, "state.productionName", 200);
    assertBoundedString(state.scheduledAt, "state.scheduledAt", 100);
    if (Number.isNaN(Date.parse(state.scheduledAt))) throw new PresetStateValidationError("state.scheduledAt must be a valid date");
    assertBoundedString(state.clock.periodLabel, "state.clock.periodLabel", 40);
    assertBoundedString(state.soccerPackage.countdown.label, "state.soccerPackage.countdown.label", 200);
    assertBoundedString(state.soccerPackage.oneLineText, "state.soccerPackage.oneLineText", 500);
    assertBoundedString(state.soccerPackage.twoLineTextA, "state.soccerPackage.twoLineTextA", 500);
    assertBoundedString(state.soccerPackage.twoLineTextB, "state.soccerPackage.twoLineTextB", 500);
    assertTeam(state.home, "state.home");
    assertTeam(state.away, "state.away");
    Object.entries(state.elements).forEach(([key, element]) => assertElement(element, `state.elements.${key}`));
    return;
  }
  if (type === "church") {
    if (!isChurchState(state)) throw new PresetStateValidationError("State does not match church preset type");
    if (state.sections.length > 100) throw new PresetStateValidationError("state.sections has too many items");
    if (state.slides.length > 500) throw new PresetStateValidationError("state.slides has too many items");
    assertBoundedString(state.serviceTitle, "state.serviceTitle", 200);
    if (state.stageMessage !== undefined) assertBoundedString(state.stageMessage, "state.stageMessage", 500);
    for (const key of ["blackout", "textCleared"] as const) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") throw new PresetStateValidationError(`state.${key} must be a boolean`);
    }
    if (new Set(state.slides.map((slide) => slide.id)).size !== state.slides.length) throw new PresetStateValidationError("Slide IDs must be unique");
    state.sections.forEach((section, index) => assertBoundedString(section, `state.sections[${index}]`, 200));
    if (state.onAirSlide !== undefined && state.onAirSlide !== null) {
      const template = createDefaultPresetState("church", "") as ChurchState;
      assertMatchesTemplate(state.onAirSlide, template.slides[0], "state.onAirSlide");
    }
    const slides = state.onAirSlide ? [...state.slides, state.onAirSlide] : state.slides;
    slides.forEach((slide, index) => {
      assertBoundedString(slide.id, `state.slides[${index}].id`, 200);
      assertBoundedString(slide.title, `state.slides[${index}].title`, 200);
      assertBoundedString(slide.text, `state.slides[${index}].text`, 10_000);
      assertBoundedString(slide.section, `state.slides[${index}].section`, 200);
      if (slide.label !== undefined) assertBoundedString(slide.label, `state.slides[${index}].label`, 80);
      if (slide.reference !== undefined) assertBoundedString(slide.reference, `state.slides[${index}].reference`, 300);
      if (slide.notes !== undefined) assertBoundedString(slide.notes, `state.slides[${index}].notes`, 2_000);
      if (slide.backgroundPreset !== undefined) assertOneOf(slide.backgroundPreset, CHURCH_BACKGROUND_PRESETS, `state.slides[${index}].backgroundPreset`);
      if (slide.backgroundMotion !== undefined && typeof slide.backgroundMotion !== "boolean") {
        throw new PresetStateValidationError(`state.slides[${index}].backgroundMotion must be a boolean`);
      }
      if (slide.textAlign !== undefined) assertOneOf(slide.textAlign, ["left", "center", "right"], `state.slides[${index}].textAlign`);
      for (const [key, min, max] of [
        ["fontSize", 32, 120],
        ["backgroundDim", 0, 90]
      ] as const) {
        const value = slide[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) {
          throw new PresetStateValidationError(`state.slides[${index}].${key} must be between ${min} and ${max}`);
        }
      }
      if (slide.mediaId !== undefined) assertBoundedString(slide.mediaId, `state.slides[${index}].mediaId`, 200);
      if (slide.mediaUrl !== undefined) assertBoundedString(slide.mediaUrl, `state.slides[${index}].mediaUrl`, 2_048);
      assertOneOf(slide.type, ["text", "image"], `state.slides[${index}].type`);
      assertOneOf(slide.variant, ["clean", "glass", "stripe", "broadcast", "neon"], `state.slides[${index}].variant`);
      assertHexColor(slide.backgroundColor, `state.slides[${index}].backgroundColor`);
      assertHexColor(slide.textColor, `state.slides[${index}].textColor`);
    });
    Object.entries(state.elements).forEach(([key, element]) => assertElement(element, `state.elements.${key}`));
    return;
  }
  if (!("title" in state) || !Array.isArray(state.elements)) throw new PresetStateValidationError("State does not match custom preset type");
  assertBoundedString(state.title, "state.title", 200);
  if (state.elements.length > 200) throw new PresetStateValidationError("state.elements has too many items");
  state.elements.forEach((element, index) => assertElement(element, `state.elements[${index}]`));
}

const labOverlays = ["full-matchup", "lower-matchup", "lower-result", "lineup-panel", "scorebug", "countdown-timer", "one-line-text", "two-line-text"] as const;

function assertTeam(team: SoccerState["home"], path: string): void {
  assertBoundedString(team.fullName, `${path}.fullName`, 120);
  assertBoundedString(team.shortName, `${path}.shortName`, 48);
  assertBoundedString(team.abbreviation, `${path}.abbreviation`, 5);
  assertHexColor(team.primaryColor, `${path}.primaryColor`);
  assertHexColor(team.secondaryColor, `${path}.secondaryColor`);
  assertBoundedString(team.rosterText, `${path}.rosterText`, 10_000);
  if (team.roster.length > 250) throw new PresetStateValidationError(`${path}.roster has too many items`);
  assertBoundedString(team.coach, `${path}.coach`, 120);
  assertBoundedString(team.schoolName, `${path}.schoolName`, 120);
  if (team.logoMediaId !== undefined) assertBoundedString(team.logoMediaId, `${path}.logoMediaId`, 200);
  if (team.logoUrl !== undefined) assertBoundedString(team.logoUrl, `${path}.logoUrl`, 2_048);
  if (Math.abs(team.imageCrop.x) > 10_000 || Math.abs(team.imageCrop.y) > 10_000)
    throw new PresetStateValidationError(`${path}.imageCrop offset is out of range`);
  for (const key of ["wins", "losses", "draws"] as const) assertNonNegativeInteger(team.record[key], `${path}.record.${key}`, 1_000_000);
  if (team.imageCrop.zoom < 0.25 || team.imageCrop.zoom > 100) throw new PresetStateValidationError(`${path}.imageCrop.zoom is out of range`);
}

function assertStyle(style: PresetState["style"], path: string): void {
  assertOneOf(style.backgroundMode, ["transparent", "solid", "checker"], `${path}.backgroundMode`);
  assertOneOf(style.theme, ["clean", "glass", "stripe", "broadcast", "neon"], `${path}.theme`);
  assertOneOf(style.animation, ["subtle", "standard", "flashy"], `${path}.animation`);
  assertBoundedString(style.font, `${path}.font`, 200);
  assertHexColor(style.accentColor, `${path}.accentColor`);
  if (style.backgroundColor !== "transparent") assertHexColor(style.backgroundColor, `${path}.backgroundColor`);
}

function assertElement(element: OverlayElementConfig, path: string): void {
  assertBoundedString(element.id, `${path}.id`, 200);
  assertOneOf(element.variant, ["clean", "glass", "stripe", "broadcast", "neon"], `${path}.variant`);
  if (element.accentColor !== undefined) assertHexColor(element.accentColor, `${path}.accentColor`);
  if (element.font !== undefined) assertBoundedString(element.font, `${path}.font`, 200);
  assertPlacement(element.placement, `${path}.placement`);
}

function assertSoccerTextAnimation(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new PresetStateValidationError(`${path} must be an object`);
  assertNonNegativeInteger(value.id, `${path}.id`, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(value.fields)) throw new PresetStateValidationError(`${path}.fields must be an array`);
  if (value.fields.length > soccerTextAnimationFields.length) {
    throw new PresetStateValidationError(`${path}.fields has too many items`);
  }
  const uniqueFields = new Set<unknown>();
  value.fields.forEach((field, index) => {
    assertOneOf(field, soccerTextAnimationFields, `${path}.fields[${index}]`);
    if (uniqueFields.has(field)) throw new PresetStateValidationError(`${path}.fields must not contain duplicates`);
    uniqueFields.add(field);
  });
}

function assertPlacement(placement: unknown, path: string): void {
  if (!isPlainObject(placement)) throw new PresetStateValidationError(`${path} must be an object`);
  assertOneOf(placement.preset, ["top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right", "custom"], `${path}.preset`);
  for (const key of ["width", "height"] as const) {
    const value = placement[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 16_384)
      throw new PresetStateValidationError(`${path}.${key} is out of range`);
  }
  if (typeof placement.scale !== "number" || !Number.isFinite(placement.scale) || placement.scale <= 0 || placement.scale > 100)
    throw new PresetStateValidationError(`${path}.scale is out of range`);
  for (const key of ["x", "y"] as const) {
    const value = placement[key];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000)
      throw new PresetStateValidationError(`${path}.${key} is out of range`);
  }
}

function assertOneOf(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new PresetStateValidationError(`${path} has an invalid value`);
}

function assertNonNegativeInteger(value: unknown, path: string, maximum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new PresetStateValidationError(`${path} must be a non-negative integer`);
  }
}

function assertBoundedString(value: unknown, path: string, maximum: number): void {
  if (typeof value !== "string" || value.length > maximum) throw new PresetStateValidationError(`${path} is too long`);
}

function assertHexColor(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new PresetStateValidationError(`${path} must be a six-digit hex color`);
}

export function blankElement() {
  return defaultElement("blank", "bottom-center", 720, 120, "clean");
}
