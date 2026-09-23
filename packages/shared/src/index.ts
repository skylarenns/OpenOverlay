export * from "./compatibility.js";

export type PresetType = "soccer" | "church" | "custom";
export type ResolutionKey = "1280x720" | "1920x1080" | "2560x1440" | "3840x2160";
export type PositionPreset = "top-center" | "top-left" | "top-right" | "bottom-center" | "bottom-left" | "bottom-right" | "custom";

export type StyleVariant = "clean" | "glass" | "stripe" | "broadcast" | "neon";
export type AnimationIntensity = "subtle" | "standard" | "flashy";
export type SoccerOverlayPackage = "rounded" | "classic";
export type SoccerLabOverlay =
  | "full-matchup"
  | "lower-matchup"
  | "lower-result"
  | "lineup-panel"
  | "scorebug"
  | "countdown-timer"
  | "one-line-text"
  | "two-line-text";
export type SoccerPackageSurface = "pitch" | "checker" | "studio";
export type SoccerBugLayout = "horizontal" | "vertical";
export type SoccerTimerMode = "full" | "small";
export type SoccerTextAnimationField =
  | "event-title"
  | "production-name"
  | "home-name"
  | "away-name"
  | "home-abbrev"
  | "away-abbrev"
  | "home-record"
  | "away-record"
  | "home-logo"
  | "away-logo"
  | "home-score"
  | "away-score"
  | "lineup-title"
  | "lineup-logo"
  | "lineup-rows"
  | "one-line"
  | "two-line-a"
  | "two-line-b";

export interface SoccerTextAnimationState {
  id: number;
  fields: SoccerTextAnimationField[];
}

export interface SoccerPackageColorBank {
  [key: string]: string;
}

export type SoccerPackageColorBanks = Record<SoccerOverlayPackage, SoccerPackageColorBank>;

export interface GlobalStyle {
  font: string;
  accentColor: string;
  backgroundMode: "transparent" | "solid" | "checker";
  backgroundColor: string;
  theme: StyleVariant;
  animation: AnimationIntensity;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  preset: PositionPreset;
}

export interface OverlayElementConfig {
  id: string;
  visible: boolean;
  placement: Placement;
  variant: StyleVariant;
  accentColor?: string;
  font?: string;
}

export interface MediaRef {
  id: string;
  url: string;
  originalFilename?: string;
}

export interface RosterEntry {
  id: string;
  line: string;
  number?: string;
  name: string;
  starter: boolean;
  position?: string;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface TeamImageCrop {
  x: number;
  y: number;
  zoom: number;
}

export interface SoccerTeam {
  fullName: string;
  shortName: string;
  abbreviation: string;
  logoMediaId?: string;
  logoUrl?: string;
  imageCrop: TeamImageCrop;
  primaryColor: string;
  secondaryColor: string;
  rosterText: string;
  roster: RosterEntry[];
  coach: string;
  schoolName: string;
  record: TeamRecord;
}

export interface TeamLibraryEntry extends SoccerTeam {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  dataRecovered?: boolean;
}

export interface SoccerClockState {
  mode: "up" | "down";
  running: boolean;
  baseSeconds: number;
  startedAtMs: number | null;
  resetSeconds: number;
  stopAtEnabled: boolean;
  stopAtSeconds: number;
  showStoppage: boolean;
  stoppageMinutes: number;
  periodLabel: string;
}

export interface SoccerStats {
  shots: { home: number; away: number };
  fouls: { home: number; away: number };
  cards: { home: number; away: number };
}

export interface SoccerCountdownPackageState {
  seconds: number;
  resetSeconds: number;
  running: boolean;
  startedAtMs: number | null;
  mode: SoccerTimerMode;
  position: PositionPreset;
  label: string;
}

export interface SoccerOverlayPackageState {
  overlayPackage: SoccerOverlayPackage;
  colorBanks: SoccerPackageColorBanks;
  textAnimation?: SoccerTextAnimationState;
  activeOverlay: SoccerLabOverlay | null;
  selectedOverlay: SoccerLabOverlay;
  surface: SoccerPackageSurface;
  packageBackground: boolean;
  packageBackgroundOpacity: number;
  scorebugLayout: SoccerBugLayout;
  scorebugWidth: number;
  lowerResultState: "HALF" | "FINAL";
  countdown: SoccerCountdownPackageState;
  oneLineText: string;
  oneLinePosition: PositionPreset;
  twoLineTextA: string;
  twoLineTextB: string;
  twoLinePosition: PositionPreset;
  lineupTeam: "home" | "away";
  lineupPage: number;
}

export type GraphicKind =
  | "goal"
  | "yellow-card"
  | "red-card"
  | "substitution"
  | "injury"
  | "halftime"
  | "matchup-full"
  | "matchup-lower"
  | "lineups"
  | "sponsor"
  | "lower-third"
  | "countdown"
  | "fullscreen"
  | "blank"
  | "team"
  | "both-teams"
  | "church-slide"
  | "church-lower-third";

export interface ActiveGraphic {
  id: string;
  kind: GraphicKind;
  title: string;
  subtitle?: string;
  label?: string;
  team?: "home" | "away" | "both" | "none";
  variant: StyleVariant;
  placement: Placement;
  startedAtMs: number;
  durationMs: number;
  expiresAtMs: number | null;
  payload?: Record<string, unknown>;
}

export interface SoccerState {
  gameTitle: string;
  productionName: string;
  scheduledAt: string;
  home: SoccerTeam;
  away: SoccerTeam;
  score: { home: number; away: number };
  stats: SoccerStats;
  clock: SoccerClockState;
  style: GlobalStyle;
  soccerPackage: SoccerOverlayPackageState;
  elements: {
    scorebug: OverlayElementConfig;
    statBug: OverlayElementConfig;
    sponsorBug: OverlayElementConfig;
    lowerThird: OverlayElementConfig;
    countdown: OverlayElementConfig;
    fullscreen: OverlayElementConfig;
  };
  activeGraphics: ActiveGraphic[];
}

export const CHURCH_BACKGROUND_PRESETS = ["solid", "aurora", "dusk", "ocean", "geometry", "rings", "stars"] as const;
export type ChurchBackgroundPreset = (typeof CHURCH_BACKGROUND_PRESETS)[number];

export interface ChurchSlide {
  id: string;
  title: string;
  type: "text" | "image";
  text: string;
  mediaId?: string;
  mediaUrl?: string;
  section: string;
  backgroundColor: string;
  textColor: string;
  variant: StyleVariant;
  label?: string;
  reference?: string;
  notes?: string;
  fontSize?: number;
  textAlign?: "left" | "center" | "right";
  backgroundDim?: number;
  backgroundPreset?: ChurchBackgroundPreset;
  backgroundMotion?: boolean;
}

export interface ChurchState {
  serviceTitle: string;
  sections: string[];
  slides: ChurchSlide[];
  selectedSlideId?: string;
  /** Snapshot of the broadcast slide. Missing preserves legacy selected-slide output. */
  onAirSlide?: ChurchSlide | null;
  blackout?: boolean;
  textCleared?: boolean;
  stageMessage?: string;
  style: GlobalStyle;
  elements: {
    lowerThird: OverlayElementConfig;
    countdown: OverlayElementConfig;
    fullscreenSlide: OverlayElementConfig;
  };
  activeGraphics: ActiveGraphic[];
}

export interface CustomState {
  title: string;
  style: GlobalStyle;
  elements: OverlayElementConfig[];
  activeGraphics: ActiveGraphic[];
}

export type PresetState = SoccerState | ChurchState | CustomState;
export const MAX_PRESET_STATE_BYTES = 512 * 1024;

export interface PresetSummary {
  /** Server time when this snapshot was produced; older servers may omit it. */
  serverTimeMs?: number;
  id: string;
  publicId: string;
  name: string;
  type: PresetType;
  revision: number;
  updatedAt: string;
  overlayClientCount?: number;
  stateRecovered?: boolean;
  state: PresetState;
}

export type PresetListItem = Omit<PresetSummary, "state" | "stateRecovered">;

export const RESOLUTIONS: Record<ResolutionKey, { width: number; height: number }> = {
  "1280x720": { width: 1280, height: 720 },
  "1920x1080": { width: 1920, height: 1080 },
  "2560x1440": { width: 2560, height: 1440 },
  "3840x2160": { width: 3840, height: 2160 }
};

export function makeId(prefix = "id"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function defaultGlobalStyle(): GlobalStyle {
  return {
    font: "Arial",
    accentColor: "#36d399",
    backgroundMode: "transparent",
    backgroundColor: "transparent",
    theme: "broadcast",
    animation: "standard"
  };
}

export function placementForPreset(preset: PositionPreset, width: number, height: number): Placement {
  const margin = 40;
  const centeredX = (1920 - width) / 2;
  const placements: Record<PositionPreset, Placement> = {
    "top-center": { x: centeredX, y: 42, width, height, scale: 1, preset },
    "top-left": { x: margin, y: 42, width, height, scale: 1, preset },
    "top-right": { x: 1920 - width - margin, y: 42, width, height, scale: 1, preset },
    "bottom-center": { x: centeredX, y: 1080 - height - 58, width, height, scale: 1, preset },
    "bottom-left": { x: margin, y: 1080 - height - 58, width, height, scale: 1, preset },
    "bottom-right": { x: 1920 - width - margin, y: 1080 - height - 58, width, height, scale: 1, preset },
    custom: { x: centeredX, y: 42, width, height, scale: 1, preset }
  };
  return placements[preset];
}

export function defaultElement(id: string, preset: PositionPreset, width: number, height: number, variant: StyleVariant): OverlayElementConfig {
  return {
    id,
    visible: true,
    placement: placementForPreset(preset, width, height),
    variant
  };
}

export function parseRoster(text: string): RosterEntry[] {
  const occurrences = new Map<string, number>();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^#?(\d{1,3})\s+(.+)$/);
      const occurrence = occurrences.get(line) ?? 0;
      occurrences.set(line, occurrence + 1);
      return {
        id: `roster_${stableTextId(`${line}\0${occurrence}`)}`,
        line,
        number: match?.[1],
        name: match?.[2]?.trim() || line,
        starter: false
      };
    });
}

function stableTextId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export const defaultTeamColors = {
  home: { primaryColor: "#0f766e", secondaryColor: "#99f6e4" },
  away: { primaryColor: "#334155", secondaryColor: "#facc15" }
} as const;

export function defaultTeam(side: "home" | "away"): SoccerTeam {
  const rosterText =
    side === "home"
      ? "1 Avery Stone\n4 Jordan Ellis\n7 Max Grenham\n9 Luca Reyes\n11 Noah Brooks"
      : "1 Riley Park\n3 Sam Carter\n8 Eli Morgan\n10 Kai Bennett\n14 Theo Hayes";
  const colors = defaultTeamColors[side];
  return {
    fullName: side === "home" ? "OpenOverlay United" : "Skyline FC",
    shortName: side === "home" ? "United" : "Skyline",
    abbreviation: side === "home" ? "OOU" : "SKY",
    imageCrop: defaultTeamImageCrop(),
    primaryColor: colors.primaryColor,
    secondaryColor: colors.secondaryColor,
    rosterText,
    roster: parseRoster(rosterText),
    coach: side === "home" ? "Coach Harper" : "Coach Lane",
    schoolName: side === "home" ? "OpenOverlay High" : "Skyline Prep",
    record: { wins: 0, losses: 0, draws: 0 }
  };
}

export function defaultTeamImageCrop(): TeamImageCrop {
  return { x: 0, y: 0, zoom: 1 };
}

export function defaultSoccerPackageState(): SoccerOverlayPackageState {
  return {
    overlayPackage: "classic",
    colorBanks: defaultSoccerPackageColorBanks(),
    activeOverlay: "full-matchup",
    selectedOverlay: "full-matchup",
    surface: "pitch",
    packageBackground: true,
    packageBackgroundOpacity: 0.78,
    scorebugLayout: "horizontal",
    scorebugWidth: 66,
    lowerResultState: "HALF",
    countdown: {
      seconds: 5 * 60,
      resetSeconds: 5 * 60,
      running: false,
      startedAtMs: null,
      mode: "full",
      position: "bottom-right",
      label: "Kickoff Countdown"
    },
    oneLineText: "Tonight on OpenOverlay",
    oneLinePosition: "bottom-left",
    twoLineTextA: "FIFA World Cup 2026",
    twoLineTextB: "Argentina vs France",
    twoLinePosition: "bottom-right",
    lineupTeam: "home",
    lineupPage: 0
  };
}

export function defaultSoccerPackageColorBanks(): SoccerPackageColorBanks {
  return {
    classic: {
      bg: "#ffffff",
      soft: "#f7f7f7",
      ink: "#111111",
      muted: "#555555",
      faint: "#e5e5e5",
      red: "#e30613",
      rule: "#111111",
      panelGray: "#3f3f3f"
    },
    rounded: {
      ink: "#f8fafc",
      muted: "#a8b3c7",
      line: "#252a34",
      gold: "#f5bd2f",
      maroon: "#7a1235",
      wine: "#3b0820",
      ivory: "#fff6e4",
      sky: "#75c8ff",
      blue: "#143b94",
      red: "#df1f34"
    }
  };
}

export function defaultClock(): SoccerClockState {
  return {
    mode: "up",
    running: false,
    baseSeconds: 0,
    startedAtMs: null,
    resetSeconds: 0,
    stopAtEnabled: true,
    stopAtSeconds: 45 * 60,
    showStoppage: true,
    stoppageMinutes: 0,
    periodLabel: "1st"
  };
}

export function createDefaultSoccerState(name = "Soccer"): SoccerState {
  return {
    gameTitle: name,
    productionName: "OpenOverlay Demo",
    scheduledAt: new Date().toISOString(),
    home: defaultTeam("home"),
    away: defaultTeam("away"),
    score: { home: 0, away: 0 },
    stats: {
      shots: { home: 0, away: 0 },
      fouls: { home: 0, away: 0 },
      cards: { home: 0, away: 0 }
    },
    clock: defaultClock(),
    style: defaultGlobalStyle(),
    soccerPackage: defaultSoccerPackageState(),
    elements: {
      scorebug: defaultElement("scorebug", "top-center", 720, 82, "broadcast"),
      statBug: defaultElement("statBug", "top-left", 330, 132, "glass"),
      sponsorBug: defaultElement("sponsorBug", "bottom-right", 260, 86, "clean"),
      lowerThird: defaultElement("lowerThird", "bottom-left", 760, 126, "stripe"),
      countdown: defaultElement("countdown", "bottom-center", 520, 126, "neon"),
      fullscreen: {
        ...defaultElement("fullscreen", "custom", 1920, 1080, "broadcast"),
        placement: { x: 0, y: 0, width: 1920, height: 1080, scale: 1, preset: "custom" }
      }
    },
    activeGraphics: []
  };
}

export function normalizeTeam(team: SoccerTeam, side: "home" | "away" = "home"): SoccerTeam {
  const fallback = defaultTeam(side);
  return {
    ...fallback,
    ...team,
    imageCrop: normalizeImageCrop(team.imageCrop),
    record: { ...fallback.record, ...(team.record || {}) },
    roster: parseRoster(team.rosterText ?? fallback.rosterText)
  };
}

export function normalizeImageCrop(crop: Partial<TeamImageCrop> | undefined): TeamImageCrop {
  return {
    x: finiteNumber(crop?.x, 0),
    y: finiteNumber(crop?.y, 0),
    zoom: Math.max(0.25, finiteNumber(crop?.zoom, 1))
  };
}

export function normalizeSoccerPackageState(packageState: Partial<SoccerOverlayPackageState> | undefined): SoccerOverlayPackageState {
  const fallback = defaultSoccerPackageState();
  const countdown = packageState?.countdown || fallback.countdown;
  const colorBanks = normalizeSoccerPackageColorBanks(packageState?.colorBanks, fallback.colorBanks);
  return {
    ...fallback,
    ...packageState,
    overlayPackage: packageState?.overlayPackage === "rounded" ? "rounded" : "classic",
    colorBanks,
    activeOverlay: isSoccerLabOverlay(packageState?.activeOverlay)
      ? packageState.activeOverlay
      : packageState?.activeOverlay === null
        ? null
        : fallback.activeOverlay,
    selectedOverlay: isSoccerLabOverlay(packageState?.selectedOverlay) ? packageState.selectedOverlay : fallback.selectedOverlay,
    surface: packageState?.surface === "checker" || packageState?.surface === "studio" ? packageState.surface : "pitch",
    packageBackgroundOpacity: clamp(finiteNumber(packageState?.packageBackgroundOpacity, fallback.packageBackgroundOpacity), 0, 1),
    scorebugLayout: packageState?.scorebugLayout === "vertical" ? "vertical" : "horizontal",
    scorebugWidth: clamp(finiteNumber(packageState?.scorebugWidth, fallback.scorebugWidth), 44, 82),
    lowerResultState: packageState?.lowerResultState === "FINAL" ? "FINAL" : "HALF",
    countdown: {
      ...fallback.countdown,
      ...countdown,
      seconds: clamp(Math.floor(finiteNumber(countdown.seconds, fallback.countdown.seconds)), 0, 35_999),
      resetSeconds: clamp(Math.floor(finiteNumber(countdown.resetSeconds, countdown.seconds ?? fallback.countdown.resetSeconds)), 0, 35_999),
      running: Boolean(countdown.running),
      startedAtMs: typeof countdown.startedAtMs === "number" ? countdown.startedAtMs : null,
      mode: countdown.mode === "small" ? "small" : "full",
      position: isPositionPreset(countdown.position) ? countdown.position : "bottom-right",
      label: typeof countdown.label === "string" && countdown.label.trim() ? countdown.label : fallback.countdown.label
    },
    oneLinePosition: isPositionPreset(packageState?.oneLinePosition) ? packageState.oneLinePosition : fallback.oneLinePosition,
    twoLinePosition: isPositionPreset(packageState?.twoLinePosition) ? packageState.twoLinePosition : fallback.twoLinePosition,
    lineupTeam: packageState?.lineupTeam === "away" ? "away" : "home",
    lineupPage: Math.max(0, Math.floor(finiteNumber(packageState?.lineupPage, 0)))
  };
}

function normalizeSoccerPackageColorBanks(
  colorBanks: Partial<SoccerPackageColorBanks> | undefined,
  fallback: SoccerPackageColorBanks
): SoccerPackageColorBanks {
  return {
    classic: normalizeColorBank(colorBanks?.classic, fallback.classic),
    rounded: normalizeColorBank(colorBanks?.rounded, fallback.rounded)
  };
}

function normalizeColorBank(colorBank: SoccerPackageColorBank | undefined, fallback: SoccerPackageColorBank): SoccerPackageColorBank {
  return Object.fromEntries(
    Object.entries(fallback).map(([key, fallbackColor]) => {
      const nextColor = colorBank?.[key];
      return [key, isHexColor(nextColor) ? nextColor : fallbackColor];
    })
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function normalizeSoccerState(state: SoccerState): SoccerState {
  return {
    ...state,
    home: normalizeTeam(state.home, "home"),
    away: normalizeTeam(state.away, "away"),
    soccerPackage: normalizeSoccerPackageState(state.soccerPackage)
  };
}

export function normalizeChurchState(state: ChurchState): ChurchState {
  const fullscreen = state.elements.fullscreenSlide;
  const placement = fullscreen.placement;
  const hasLegacyFullscreenOffset =
    placement.preset === "custom" && placement.x === 0 && placement.y === 42 && placement.width === 1920 && placement.height === 1080 && placement.scale === 1;

  if (!hasLegacyFullscreenOffset) return state;

  return {
    ...state,
    elements: {
      ...state.elements,
      fullscreenSlide: {
        ...fullscreen,
        placement: { ...placement, y: 0 }
      }
    }
  };
}

export function createDefaultChurchState(name = "Church Sunday"): ChurchState {
  const titleSlide: ChurchSlide = {
    id: makeId("slide"),
    title: "Welcome",
    type: "text",
    text: "Welcome\nWe are glad you are here",
    section: "Pre-service",
    backgroundColor: "#111827",
    textColor: "#ffffff",
    variant: "glass"
  };
  return {
    serviceTitle: name,
    sections: ["Pre-service", "Worship", "Message", "Closing"],
    slides: [titleSlide],
    selectedSlideId: titleSlide.id,
    style: {
      ...defaultGlobalStyle(),
      accentColor: "#60a5fa",
      theme: "glass"
    },
    elements: {
      lowerThird: defaultElement("churchLowerThird", "bottom-left", 780, 130, "glass"),
      countdown: defaultElement("churchCountdown", "bottom-right", 430, 120, "clean"),
      fullscreenSlide: {
        ...defaultElement("churchFullscreen", "custom", 1920, 1080, "glass"),
        placement: { x: 0, y: 0, width: 1920, height: 1080, scale: 1, preset: "custom" }
      }
    },
    activeGraphics: []
  };
}

export function createDefaultCustomState(name = "Custom"): CustomState {
  return {
    title: name,
    style: defaultGlobalStyle(),
    elements: [defaultElement("customLower", "bottom-center", 720, 120, "clean")],
    activeGraphics: []
  };
}

export function createDefaultPresetState(type: PresetType, name: string): PresetState {
  if (type === "soccer") return createDefaultSoccerState(name);
  if (type === "church") return createDefaultChurchState(name);
  return createDefaultCustomState(name);
}

export function emptyTeam(side: "home" | "away"): SoccerTeam {
  return {
    ...defaultTeam(side),
    fullName: side === "home" ? "Home Team" : "Away Team",
    shortName: side === "home" ? "Home" : "Away",
    abbreviation: side === "home" ? "HOME" : "AWAY",
    rosterText: "",
    roster: [],
    coach: "",
    schoolName: ""
  };
}

/** Blank production defaults; sample factories remain available for demos and recovery. */
export function createNewPresetState(type: PresetType, name: string): PresetState {
  const state = createDefaultPresetState(type, name);
  if (type === "soccer" && "soccerPackage" in state) {
    state.home = emptyTeam("home");
    state.away = emptyTeam("away");
    state.productionName = "";
    state.soccerPackage.activeOverlay = null;
    state.soccerPackage.selectedOverlay = "scorebug";
    state.soccerPackage.oneLineText = "";
    state.soccerPackage.twoLineTextA = "";
    state.soccerPackage.twoLineTextB = "";
  }
  if (type === "church" && "slides" in state) {
    state.slides = [{ ...state.slides[0], title: "Slide 1", text: "" }];
    state.onAirSlide = null;
    state.elements.fullscreenSlide.visible = false;
  }
  return state;
}

export function churchOnAirSlide(state: ChurchState): ChurchSlide | null {
  return state.onAirSlide === undefined ? (state.slides.find((slide) => slide.id === state.selectedSlideId) ?? state.slides[0] ?? null) : state.onAirSlide;
}

export { churchSections, orderedChurchSlides, prepareChurchSlides, importChurchService, exportChurchService, MAX_SERVICE_FILE_BYTES } from "./church.js";

function isSoccerLabOverlay(value: unknown): value is SoccerLabOverlay {
  return (
    typeof value === "string" &&
    ["full-matchup", "lower-matchup", "lower-result", "lineup-panel", "scorebug", "countdown-timer", "one-line-text", "two-line-text"].includes(value)
  );
}

function isPositionPreset(value: unknown): value is PositionPreset {
  return typeof value === "string" && ["top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right", "custom"].includes(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeClockSeconds(clock: SoccerClockState, nowMs = Date.now()): number {
  let seconds = clock.baseSeconds;
  if (clock.running && clock.startedAtMs !== null) {
    const delta = Math.max(0, Math.floor((nowMs - clock.startedAtMs) / 1000));
    seconds = clock.mode === "up" ? clock.baseSeconds + delta : clock.baseSeconds - delta;
  }
  if (clock.stopAtEnabled) {
    if (clock.mode === "up") seconds = Math.min(seconds, clock.stopAtSeconds);
    else seconds = Math.max(seconds, clock.stopAtSeconds);
  }
  return Math.max(0, seconds);
}

export function clockIsAtStop(clock: SoccerClockState, nowMs = Date.now()): boolean {
  if (!clock.stopAtEnabled) return false;
  const seconds = computeClockSeconds(clock, nowMs);
  return clock.mode === "up" ? seconds >= clock.stopAtSeconds : seconds <= clock.stopAtSeconds;
}

export function pauseClock(clock: SoccerClockState, nowMs = Date.now()): SoccerClockState {
  return {
    ...clock,
    running: false,
    baseSeconds: computeClockSeconds(clock, nowMs),
    startedAtMs: null
  };
}

export function startClock(clock: SoccerClockState, nowMs = Date.now()): SoccerClockState {
  let nextClock = clock;
  if (clock.mode === "down" && clock.stopAtEnabled && clock.stopAtSeconds >= computeClockSeconds(clock, nowMs)) {
    nextClock = { ...clock, stopAtSeconds: 0 };
  }
  if (nextClock.running) return nextClock;
  if (clockIsAtStop(nextClock, nowMs)) {
    return { ...nextClock, running: false };
  }
  return {
    ...nextClock,
    running: true,
    startedAtMs: nowMs
  };
}

export function resetClock(clock: SoccerClockState): SoccerClockState {
  return {
    ...clock,
    running: false,
    baseSeconds: clock.resetSeconds,
    startedAtMs: null
  };
}

export function setClockSeconds(clock: SoccerClockState, seconds: number): SoccerClockState {
  const nextSeconds = Number.isFinite(seconds) ? Math.max(0, Math.min(1_000_000, Math.floor(seconds))) : 0;
  return {
    ...clock,
    running: false,
    baseSeconds: nextSeconds,
    resetSeconds: nextSeconds,
    startedAtMs: null
  };
}

export function parseClockTime(input: string): number {
  return tryParseClockTime(input) ?? 0;
}

/**
 * Parses user-entered clock text without conflating invalid input with a
 * legitimate zero-second value. `parseClockTime` retains its historical
 * zero fallback for callers that need backwards compatibility.
 */
export function tryParseClockTime(input: string): number | null {
  const trimmed = input.trim();
  const secondsOnly = /^(\d+)$/.exec(trimmed);
  if (secondsOnly) return nullableClockSeconds(Number(secondsOnly[1]));
  const clock = /^(\d+):([0-5]?\d)$/.exec(trimmed);
  if (!clock) return null;
  const total = Number(clock[1]) * 60 + Number(clock[2]);
  return nullableClockSeconds(total);
}

export function formatClock(seconds: number): string {
  const clamped = safeClockSeconds(seconds);
  const minutes = Math.floor(clamped / 60);
  const remainder = clamped % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function safeClockSeconds(value: number): number {
  return nullableClockSeconds(value) ?? 0;
}

function nullableClockSeconds(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

export function formatSoccerClock(clock: SoccerClockState, nowMs = Date.now()): string {
  const base = formatClock(computeClockSeconds(clock, nowMs));
  if (clock.showStoppage && clock.stoppageMinutes > 0) {
    return `${base} +${clock.stoppageMinutes}`;
  }
  return base;
}

export function withoutExpiredGraphics<T extends { activeGraphics: ActiveGraphic[] }>(state: T, nowMs = Date.now()): T {
  return {
    ...state,
    activeGraphics: state.activeGraphics.filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > nowMs)
  };
}
