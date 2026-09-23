import { ChurchWorkspace } from "./components/ChurchWorkspace";
import { ActionMenu, CopyButton, RecordInput } from "./components/Controls";
import { CachedPages } from "./components/CachedPages";
import { announceMediaUpload, MEDIA_UPLOADED_EVENT, MediaPicker, mergeMediaItems } from "./components/MediaPicker";
import { StageLinkControls } from "./components/StageLinkControls";
import { ModalLayer } from "./components/ModalLayer";
import { Dashboard, formatOverlayClientCount } from "./pages/Dashboard";
import { PRESET_DELETED_UI_EVENT, dispatchPresetDeleted } from "./lib/uiEvents";
import { MediaLibrary } from "./pages/MediaLibrary";
export { MediaLibrary } from "./pages/MediaLibrary";
import { PageSkeleton, SidebarSkeleton, TeamEditorSkeleton, TeamListSkeleton } from "./components/PageSkeleton";
import { RealtimeRetry } from "./lib/realtimeRetry";
import { OverlayPage } from "./OverlayPage";
export { OverlayPage } from "./OverlayPage";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import {
  AlertTriangle,
  Bug,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  Image,
  KeyRound,
  LayoutDashboard,
  Github,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Pause,
  Plus,
  RotateCcw,
  Share2,
  ShieldAlert,
  Square,
  Sun,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import {
  OPENOVERLAY_API_VERSION,
  OPENOVERLAY_REALTIME_VERSION,
  computeClockSeconds,
  clockIsAtStop,
  pauseClock,
  createDefaultChurchState,
  createDefaultSoccerState,
  defaultTeamColors,
  churchOnAirSlide,
  formatClock,
  makeId,
  parseRoster,
  tryParseClockTime,
  placementForPreset,
  setClockSeconds,
  type ChurchState,
  type OverlayElementConfig,
  type PositionPreset,
  type PresetListItem,
  type PresetState,
  type PresetSummary,
  type SoccerLabOverlay,
  type SoccerOverlayPackage,
  type SoccerState,
  type SoccerTextAnimationField,
  type StyleVariant,
  type TeamLibraryEntry
} from "@openoverlay/shared";
import { getElementById, OverlayRenderer } from "./components/OverlayRenderer";
import {
  AUTH_EXPIRED_EVENT,
  FRONTEND_BUILD,
  WS_URL,
  ApiError,
  authApi,
  isPreset,
  isPresetDeletedEvent,
  isRealtimeErrorMessage,
  mediaApi,
  overlayApi,
  presetApi,
  statusApi,
  teamApi,
  type BuildInfo,
  type MediaItem,
  type PresetDeletedEvent,
  type PresetEvent,
  type User
} from "./lib/api";
import { DebouncedSerialMutationQueue, KeyedDebouncer, KeyedSerialTaskQueue } from "./lib/mutationQueue";

const pendingActionKeys = new Map<string, string>();

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  logout(beforeSessionClear?: () => void): Promise<void>;
}

interface PromptDialogOptions {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  inputType?: string;
}

type Theme = "light" | "dark";
type SoccerEditorTab = "match" | "live" | "setup";
type DeploymentCheckResult =
  | { status: "idle" | "ok" }
  | { status: "mismatch"; frontend: BuildInfo; backend: BuildInfo }
  | { status: "unknown"; reason: string }
  | { status: "error"; reason: string };

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const PromptDialogContext = createContext<((options: PromptDialogOptions) => Promise<string | null>) | null>(null);
const ThemeContext = createContext<ThemeContextValue | null>(null);
const defaultSoccerEditorTabs: SoccerEditorTab[] = ["match", "live", "setup"];
const soccerTabLabels: Record<SoccerEditorTab, string> = { match: "Match", live: "Live", setup: "Design" };

const THEME_STORAGE_KEY = "openoverlay:theme";
const SIDEBAR_WIDTH_STORAGE_KEY = "openoverlay:sidebar-width";
const SIDEBAR_MIN_WIDTH = 232;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_DEFAULT_WIDTH = 232;
const PROGRAMMATIC_NAVIGATION_EVENT = "openoverlay:before-programmatic-navigation";
const ALLOW_PROGRAMMATIC_NAVIGATION_EVENT = "openoverlay:allow-programmatic-navigation";
const DEPLOYMENT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TEAM_COLOR_PAIRS = [defaultTeamColors.home, defaultTeamColors.away];
export function App() {
  return (
    <ThemeProvider>
      <PromptDialogProvider>
        <AuthProvider>
          <DeploymentCompatibilityChecker />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login mode="login" />} />
            <Route path="/signup" element={<Login mode="signup" />} />
            <Route path="/overlay/:overlayId" element={<OverlayPage test={false} />} />
            <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
            <Route
              path="/dash/*"
              element={
                <RequireAuth>
                  <Workspace />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </PromptDialogProvider>
    </ThemeProvider>
  );
}

function Workspace() {
  const { user } = useAuth();
  return (
    <AppShell>
      <CachedPages key={user?.id}>
        {(location) => (
          <Routes location={location}>
            <Route index element={<Dashboard />} />
            <Route path="teams" element={<TeamsLibrary />} />
            <Route path="media" element={<MediaLibrary />} />
            <Route path="presets/:presetId" element={<PresetEditor />} />
            <Route path="*" element={<Navigate to="/dash" replace />} />
          </Routes>
        )}
      </CachedPages>
    </AppShell>
  );
}

function DeploymentCompatibilityChecker() {
  const location = useLocation();
  const [result, setResult] = useState<DeploymentCheckResult>({ status: "idle" });
  const isOverlayOutput = location.pathname.startsWith("/overlay/");

  useEffect(() => {
    if (isOverlayOutput) return;

    const controller = new AbortController();
    let timeoutId: number | undefined;

    async function check() {
      try {
        const health = await statusApi.health(controller.signal);
        if (controller.signal.aborted) return;
        const backendBuild = health.build;
        const supportsFrontendApi = health.compatibility?.api?.supported.includes(FRONTEND_BUILD.requiredApiVersion);
        const supportsFrontendRealtime = health.compatibility?.realtime?.supported.includes(FRONTEND_BUILD.requiredRealtimeVersion);

        if (supportsFrontendApi === false || supportsFrontendRealtime === false) {
          setResult({
            status: "error",
            reason: `Backend does not support required API/realtime version ${FRONTEND_BUILD.requiredApiVersion}/${FRONTEND_BUILD.requiredRealtimeVersion}.`
          });
          return;
        }

        if (FRONTEND_BUILD.commit && backendBuild?.commit) {
          setResult(FRONTEND_BUILD.commit === backendBuild.commit ? { status: "ok" } : { status: "mismatch", frontend: FRONTEND_BUILD, backend: backendBuild });
          return;
        }

        if (import.meta.env.PROD) {
          const missing = [FRONTEND_BUILD.commit ? null : "frontend", backendBuild?.commit ? null : "backend"].filter(Boolean).join(" and ");
          setResult({ status: "unknown", reason: `Missing ${missing} build metadata.` });
        } else {
          setResult({ status: "ok" });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setResult({ status: "error", reason: error instanceof Error ? error.message : "Could not reach backend health." });
      } finally {
        if (!controller.signal.aborted) {
          timeoutId = window.setTimeout(check, DEPLOYMENT_CHECK_INTERVAL_MS);
        }
      }
    }

    void check();

    return () => {
      controller.abort();
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isOverlayOutput]);

  if (isOverlayOutput) return null;

  let message: string;
  let tone: "warn" | "neutral";

  switch (result.status) {
    case "mismatch":
      message = `Frontend build ${formatBuildLabel(result.frontend)} and backend build ${formatBuildLabel(result.backend)} differ. Redeploy the stale side before going live.`;
      tone = "warn";
      break;
    case "unknown":
      message = `Deployment sync check incomplete. ${result.reason}`;
      tone = "neutral";
      break;
    case "error":
      message = `Deployment sync check failed. ${result.reason}`;
      tone = "neutral";
      break;
    default:
      return null;
  }

  return (
    <div className={`deployment-check-banner ${tone}`} role={result.status === "mismatch" ? "alert" : "status"}>
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function formatBuildLabel(build: BuildInfo): string {
  return build.commitShort || build.commit?.slice(0, 7) || build.version || "unknown";
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // Fall through to the OS preference when storage is unavailable.
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage may be unavailable; safe to ignore
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("Theme context missing");
  return ctx;
}

function useResizableSidebar() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    try {
      const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      if (!Number.isFinite(stored) || stored <= 0) return SIDEBAR_DEFAULT_WIDTH;
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, stored));
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const [resizing, setResizing] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // ignore
    }
  }, [width]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const startDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragCleanupRef.current?.();
    setResizing(true);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: MouseEvent) {
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, moveEvent.clientX));
      setWidth(next);
    }
    function cleanup() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    }
    function onUp() {
      cleanup();
      setResizing(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragCleanupRef.current = cleanup;
  }, []);

  const resizeWithKeyboard = useCallback(
    (event: React.KeyboardEvent) => {
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = width - 8;
      if (event.key === "ArrowRight") next = width + 8;
      if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
      if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
      if (next === null) return;
      event.preventDefault();
      setWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)));
    },
    [width]
  );

  return { width, resizing, startDrag, resizeWithKeyboard };
}

export function PromptDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<PromptDialogOptions | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const close = useCallback((result: string | null) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialog(null);
    setValue("");
  }, []);

  const prompt = useCallback((options: PromptDialogOptions) => {
    resolverRef.current?.(null);
    setValue(options.defaultValue ?? "");
    setDialog(options);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const id = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(id);
  }, [dialog]);

  useEffect(() => () => resolverRef.current?.(null), []);

  return (
    <PromptDialogContext.Provider value={prompt}>
      {children}
      {dialog ? (
        <ModalLayer initialFocusRef={inputRef} onClose={() => close(null)}>
          <form
            className="prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              close(value);
            }}
          >
            <h2 id="prompt-dialog-title">{dialog.title}</h2>
            <label className="field">
              <span>{dialog.label}</span>
              <input
                ref={inputRef}
                type={dialog.inputType || "text"}
                value={value}
                placeholder={dialog.placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <div className="control-row prompt-actions">
              <button className="button" type="button" onClick={() => close(null)}>
                Cancel
              </button>
              <button className="button primary" type="submit">
                {dialog.submitLabel || "OK"}
              </button>
            </div>
          </form>
        </ModalLayer>
      ) : null}
    </PromptDialogContext.Provider>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const shouldLoadSession = location.pathname.startsWith("/dash");
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    setLoading(true);
    try {
      const response = await authApi.me();
      if (refreshGenerationRef.current !== generation) return;
      setUser(response.user);
      setError(null);
    } catch (err) {
      if (refreshGenerationRef.current !== generation) return;
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Authentication service is unavailable");
      }
    } finally {
      if (refreshGenerationRef.current === generation) {
        setLoading(false);
        setSessionChecked(true);
      }
    }
  }, []);

  useEffect(() => {
    if (shouldLoadSession && !sessionChecked) void refresh();
  }, [refresh, sessionChecked, shouldLoadSession]);

  useEffect(() => {
    const expire = () => {
      refreshGenerationRef.current += 1;
      pendingActionKeys.clear();
      setUser(null);
      setError(null);
      setLoading(false);
      setSessionChecked(true);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expire);
  }, []);

  const logout = useCallback(async (beforeSessionClear?: () => void) => {
    refreshGenerationRef.current += 1;
    setLoading(false);
    await authApi.logout();
    pendingActionKeys.clear();
    beforeSessionClear?.();
    setUser(null);
    setError(null);
    setSessionChecked(true);
  }, []);

  const authLoading = shouldLoadSession && (!sessionChecked || loading);
  return <AuthContext.Provider value={{ user, loading: authLoading, error, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("Auth context missing");
  return ctx;
}

function usePromptDialog() {
  const ctx = useContext(PromptDialogContext);
  if (!ctx) throw new Error("Prompt dialog context missing");
  return ctx;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-page">Loading...</div>;
  if (error && !user) {
    return (
      <div className="auth-page">
        <div className="auth-panel" role="alert">
          <h1>OpenOverlay is unavailable</h1>
          <p>{error}</p>
          <button className="button primary" type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <>{children}</>;
}

function Home() {
  const { user } = useAuth();
  return (
    <div className="site-shell marketing">
      <header className="topbar">
        <Link to="/" className="brand">
          <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
          <span>OpenOverlay</span>
        </Link>
        <div className="nav-actions">
          <Link className="button" to={user ? "/dash" : "/login"}>
            {user ? "Open dashboard" : "Login"}
          </Link>
        </div>
      </header>
      <main className="hero">
        <section>
          <h1>OpenOverlay</h1>
          <p>Free and open-source livestream graphics.</p>
          <div className="hero-actions">
            <Link className="button primary" to={user ? "/dash" : "/signup"}>
              {user ? "Open dashboard" : "Create account"}
            </Link>
          </div>
        </section>
        <section className="hero-preview" aria-label="Overlay preview">
          <OverlayRenderer type="soccer" state={demoSoccerState()} transparent={false} />
        </section>
      </main>
      <footer className="home-footer">
        <a
          className="home-footer-link"
          href="https://github.com/Skytheredhead/OpenOverlay"
          target="_blank"
          rel="noreferrer"
          aria-label="OpenOverlay GitHub repository"
        >
          <Github size={18} />
          <span>OpenOverlay</span>
        </a>
      </footer>
    </div>
  );
}

function Login({ mode }: { mode: "login" | "signup" }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "signup") await authApi.signup(email, password);
      else await authApi.login(email, password);
      await refresh();
      const requestedPath = (location.state as { from?: unknown } | null)?.from;
      const destination = typeof requestedPath === "string" && requestedPath.startsWith("/dash") && !requestedPath.startsWith("//") ? requestedPath : "/dash";
      void navigate(destination, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="site-shell auth-page">
      <div className="auth-stack">
        <Link to="/" className="brand auth-brand">
          <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
          <span>OpenOverlay</span>
        </Link>
        <form className="auth-panel" onSubmit={submit}>
          <h1>{mode === "signup" ? "Create account" : "Login"}</h1>
          <div className="form-grid">
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={8}
                required
              />
            </label>
            <button className="button primary" type="submit" disabled={submitting}>
              {submitting ? "Please wait..." : mode === "signup" ? "Sign up" : "Login"}
            </button>
          </div>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
          <p className="muted" style={{ marginTop: 16 }}>
            {mode === "signup" ? "Already have an account? " : "Need an account? "}
            <Link to={mode === "signup" ? "/login" : "/signup"}>{mode === "signup" ? "Login" : "Sign up"}</Link>
          </p>
        </form>
      </div>
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const { width: sidebarWidth, resizing, startDrag, resizeWithKeyboard } = useResizableSidebar();
  const [games, setGames] = useState<PresetListItem[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [manualSidebarCollapsed, setManualSidebarCollapsed] = useState(false);
  const [mobileSidebarCollapsed, setMobileSidebarCollapsed] = useState(true);
  const [isMobileSidebar, setIsMobileSidebar] = useState(() => window.matchMedia?.("(max-width: 760px)").matches ?? false);
  const sidebarCollapsed = isMobileSidebar ? mobileSidebarCollapsed : manualSidebarCollapsed;
  const [presetMenu, setPresetMenu] = useState<{ game: PresetListItem; x: number; y: number; trigger: HTMLElement | null } | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  const [sidebarMutationBusy, setSidebarMutationBusy] = useState(false);
  const sidebarMutationBusyRef = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const update = () => setIsMobileSidebar(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (isMobileSidebar) setMobileSidebarCollapsed(true);
  }, [isMobileSidebar, location.pathname]);

  useEffect(() => {
    const controller = new AbortController();
    void presetApi
      .list(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setGames(response.presets);
        setGamesLoaded(true);
        setShellError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setShellError(err instanceof Error ? err.message : "Could not load sidebar productions");
        setGamesLoaded(true);
      });
    return () => controller.abort();
  }, [location.pathname]);

  useEffect(() => {
    function handlePresetDeleted(event: Event) {
      const payload = event instanceof CustomEvent ? event.detail : undefined;
      if (!isPresetDeletedEvent(payload)) return;
      setGames((current) => current.filter((item) => item.id !== payload.id));
      setPresetMenu((current) => (current?.game.id === payload.id ? null : current));
    }
    window.addEventListener(PRESET_DELETED_UI_EVENT, handlePresetDeleted);
    return () => window.removeEventListener(PRESET_DELETED_UI_EVENT, handlePresetDeleted);
  }, []);

  useEffect(() => {
    if (!presetMenu) return;
    const activeMenu = presetMenu;
    function closeMenu() {
      setPresetMenu(null);
    }
    function handleMenuKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const trigger = activeMenu.trigger;
        closeMenu();
        window.setTimeout(() => trigger?.focus(), 0);
        return;
      }
      const menu = presetMenuRef.current;
      if (!menu || !menu.contains(document.activeElement)) return;
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      if (items.length === 0) return;
      const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleMenuKeyboard);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleMenuKeyboard);
    };
  }, [presetMenu]);

  useEffect(() => {
    if (!presetMenu) return;
    const id = window.setTimeout(() => presetMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [presetMenu]);

  function openPresetMenu(game: PresetListItem, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 176;
    const menuHeight = 92;
    setPresetMenu({
      game,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
      trigger
    });
  }

  async function duplicateSidebarPreset(game: PresetListItem) {
    if (sidebarMutationBusyRef.current) return;
    if (!requestProgrammaticNavigation()) return;
    const sourceLocationKey = locationRef.current.key;
    sidebarMutationBusyRef.current = true;
    setSidebarMutationBusy(true);
    try {
      const response = await presetApi.duplicate(game.id);
      setGames((current) => [response.preset, ...current]);
      setPresetMenu(null);
      setShellError(null);
      if (locationRef.current.key !== sourceLocationKey) return;
      allowProgrammaticNavigation();
      void navigate(`/dash/presets/${response.preset.id}`);
    } catch (err) {
      setShellError(err instanceof Error ? err.message : "Could not duplicate game");
    } finally {
      sidebarMutationBusyRef.current = false;
      setSidebarMutationBusy(false);
    }
  }

  async function deleteSidebarPreset(game: PresetListItem) {
    if (sidebarMutationBusyRef.current) return;
    if (!window.confirm(`Delete ${game.name}?`)) return;
    const deletesCurrentGame = location.pathname === `/dash/presets/${game.id}`;
    if (deletesCurrentGame && !requestProgrammaticNavigation()) return;
    const sourceLocationKey = locationRef.current.key;
    sidebarMutationBusyRef.current = true;
    setSidebarMutationBusy(true);
    try {
      // Delete the revision the operator actually saw. Fetching the latest
      // revision here would silently accept and destroy an unseen concurrent
      // edit, defeating the purpose of the server's delete precondition.
      await presetApi.remove(game.id, game.revision);
      setGames((current) => current.filter((item) => item.id !== game.id));
      setPresetMenu(null);
      setShellError(null);
      if (deletesCurrentGame && locationRef.current.key === sourceLocationKey) {
        allowProgrammaticNavigation();
        void navigate("/dash");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGames((current) => current.filter((item) => item.id !== game.id));
        setPresetMenu(null);
        setShellError("That game was already deleted in another session.");
        if (deletesCurrentGame && locationRef.current.key === sourceLocationKey) {
          allowProgrammaticNavigation();
          void navigate("/dash");
        }
      } else if (err instanceof ApiError && err.status === 409) {
        try {
          const response = await presetApi.list();
          setGames(response.presets);
        } catch (refreshError) {
          const refreshMessage = refreshError instanceof Error ? refreshError.message : "sidebar refresh failed";
          setShellError(`That game changed while it was being deleted, and the sidebar could not be refreshed: ${refreshMessage}`);
          return;
        }
        setShellError("That game changed while it was being deleted. Review the latest version and try again.");
      } else {
        setShellError(err instanceof Error ? err.message : "Could not delete game");
      }
    } finally {
      sidebarMutationBusyRef.current = false;
      setSidebarMutationBusy(false);
    }
  }

  const shellStyle = { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties;
  const shellClass = ["app-shell", sidebarCollapsed ? "sidebar-collapsed" : "", resizing ? "is-resizing" : ""].filter(Boolean).join(" ");

  return (
    <div className={shellClass} style={shellStyle}>
      <aside className="sidebar">
        <div className="sidebar-nav-wrap">
          <div className="sidebar-header">
            <Link to="/dash" className="brand sidebar-brand" aria-label="OpenOverlay dashboard">
              <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
              <span className="sidebar-brand-text">OpenOverlay</span>
            </Link>
            <button
              className="sidebar-collapse-toggle"
              type="button"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="workspace-navigation"
              onClick={() => {
                if (isMobileSidebar) {
                  setMobileSidebarCollapsed((value) => !value);
                } else {
                  setManualSidebarCollapsed((value) => !value);
                }
              }}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={19} strokeWidth={2.2} /> : <PanelLeftClose size={19} strokeWidth={2.2} />}
            </button>
          </div>
          <nav id="workspace-navigation" className="sidebar-nav" aria-label="Workspace" inert={sidebarCollapsed} aria-hidden={sidebarCollapsed}>
            <NavLink to="/dash" end>
              <LayoutDashboard size={18} /> <span className="nav-label">Productions</span>
            </NavLink>
            {!gamesLoaded ? (
              <SidebarSkeleton />
            ) : games.length > 0 ? (
              <div className="sidebar-subnav" aria-label="Productions">
                {games.map((game) => (
                  <NavLink
                    key={game.id}
                    to={`/dash/presets/${game.id}`}
                    aria-label={game.name}
                    title={game.name}
                    onMouseDown={(event) => {
                      if (event.button !== 2) return;
                      event.preventDefault();
                      openPresetMenu(game, event.clientX, event.clientY, event.currentTarget);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openPresetMenu(game, event.clientX, event.clientY, event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openPresetMenu(game, rect.right, rect.top, event.currentTarget);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={presetMenu?.game.id === game.id}
                  >
                    <CircleDot size={16} aria-hidden="true" />
                    <span className="nav-label">{game.name}</span>
                  </NavLink>
                ))}
              </div>
            ) : null}
            <NavLink to="/dash/teams" className="sidebar-library-start">
              <Users size={18} /> <span className="nav-label">Teams</span>
            </NavLink>
            <NavLink to="/dash/media">
              <Image size={18} /> <span className="nav-label">Media</span>
            </NavLink>
          </nav>
        </div>
        <div className="sidebar-account" inert={sidebarCollapsed} aria-hidden={sidebarCollapsed}>
          <p className="muted">{user?.email}</p>
          <button
            className="sidebar-theme-toggle"
            type="button"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={18} strokeWidth={2.2} /> : <Moon size={18} strokeWidth={2.2} />}
          </button>
          <button
            className="sidebar-logout"
            type="button"
            aria-label="Logout"
            title="Logout"
            onClick={() => {
              if (!requestProgrammaticNavigation()) return;
              void logout(allowProgrammaticNavigation).catch((err) => setShellError(err instanceof Error ? err.message : "Could not log out"));
            }}
          >
            <LogOut size={20} strokeWidth={2.4} />
          </button>
        </div>
        {!sidebarCollapsed ? (
          <div
            className="sidebar-resize-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarWidth}
            onMouseDown={startDrag}
            onKeyDown={resizeWithKeyboard}
          />
        ) : null}
      </aside>
      {presetMenu ? (
        <div
          ref={presetMenuRef}
          className="sidebar-preset-menu"
          role="menu"
          aria-label={`${presetMenu.game.name} actions`}
          style={{ left: presetMenu.x, top: presetMenu.y } as React.CSSProperties}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" disabled={sidebarMutationBusy} onClick={() => void duplicateSidebarPreset(presetMenu.game)}>
            <Copy size={15} /> {sidebarMutationBusy ? "Working..." : "Duplicate"}
          </button>
          <button type="button" role="menuitem" className="danger" disabled={sidebarMutationBusy} onClick={() => void deleteSidebarPreset(presetMenu.game)}>
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : null}
      <main className="main">
        {shellError ? (
          <div className="error shell-error" role="alert">
            {shellError}
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}

export function TeamsLibrary() {
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<TeamLibraryEntry[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaStatus, setMediaStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamLibraryEntry | null>(null);
  const [deletingTeamIds, setDeletingTeamIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [saveStatuses, setSaveStatuses] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});
  const draftRef = useRef<TeamLibraryEntry | null>(null);
  const teamsRef = useRef<TeamLibraryEntry[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const teamSaveRevisionRef = useRef(0);
  const latestTeamSaveRevisionRef = useRef<Record<string, number>>({});
  const serverTeamRevisionRef = useRef<Record<string, number>>({});
  const conflictedTeamIdsRef = useRef(new Set<string>());
  const teamSaveQueueRef = useRef<KeyedSerialTaskQueue | null>(null);
  if (!teamSaveQueueRef.current) teamSaveQueueRef.current = new KeyedSerialTaskQueue();
  const teamsMountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const mediaLoadGenerationRef = useRef(0);
  const pendingTeamIdsRef = useRef(new Set<string>());
  const teamSaveDebouncerRef = useRef<KeyedDebouncer | null>(null);
  if (!teamSaveDebouncerRef.current) teamSaveDebouncerRef.current = new KeyedDebouncer(500);
  const prompt = usePromptDialog();
  const allowNextNavigationRef = useRef(false);

  const hasPendingTeamSave = useCallback(() => pendingTeamIdsRef.current.size > 0, []);
  useUnsavedNavigationBlocker(hasPendingTeamSave, allowNextNavigationRef, "Team changes are still saving. Leave this page anyway?");

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const mediaGeneration = ++mediaLoadGenerationRef.current;
    setMediaStatus("loading");
    // Optional images must not delay the primary team editor or reject unhandled.
    const mediaRequest = mediaApi.list(signal).then(
      (response) => ({ ok: true as const, response }),
      () => ({ ok: false as const })
    );
    const teamsResponse = await teamApi.list(signal);
    if (signal?.aborted || generation !== loadGenerationRef.current) return;
    teamSaveDebouncerRef.current?.clear();
    for (const pendingTeamId of pendingTeamIdsRef.current) {
      const invalidationRevision = teamSaveRevisionRef.current + 1;
      teamSaveRevisionRef.current = invalidationRevision;
      latestTeamSaveRevisionRef.current[pendingTeamId] = invalidationRevision;
    }
    serverTeamRevisionRef.current = Object.fromEntries(teamsResponse.teams.map((team) => [team.id, team.revision]));
    conflictedTeamIdsRef.current.clear();
    pendingTeamIdsRef.current.clear();
    teamsRef.current = teamsResponse.teams;
    setTeams(teamsResponse.teams);
    const selected = teamsResponse.teams.find((team) => team.id === selectedIdRef.current) ?? teamsResponse.teams[0] ?? null;
    const nextDraft = selected ? structuredClone(selected) : null;
    selectedIdRef.current = selected?.id ?? null;
    draftRef.current = nextDraft;
    setSelectedId(selectedIdRef.current);
    setDraft(nextDraft);
    setLoading(false);
    setSaveStatuses({});
    const recoveredCount = teamsResponse.teams.filter((team) => team.dataRecovered).length;
    if (recoveredCount > 0) {
      setError(
        `${recoveredCount} stored team ${recoveredCount === 1 ? "record was" : "records were"} corrupt and loaded with safe defaults. Review and resave ${recoveredCount === 1 ? "it" : "them"}.`
      );
    } else {
      setError(null);
    }
    const mediaResult = await mediaRequest;
    if (signal?.aborted || !teamsMountedRef.current || mediaGeneration !== mediaLoadGenerationRef.current) return;
    if (mediaResult.ok) {
      setMedia((current) => mergeMediaItems(mediaResult.response.media, current));
      setMediaStatus("ready");
    } else setMediaStatus("failed");
  }, []);

  async function retryMedia() {
    const generation = ++mediaLoadGenerationRef.current;
    setMediaStatus("loading");
    try {
      const result = await mediaApi.list();
      if (!teamsMountedRef.current || mediaLoadGenerationRef.current !== generation) return;
      setMedia((current) => mergeMediaItems(result.media, current));
      setMediaStatus("ready");
    } catch {
      if (teamsMountedRef.current && mediaLoadGenerationRef.current === generation) setMediaStatus("failed");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((err) => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(err instanceof Error ? err.message : "Could not load teams");
      }
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const uploaded = (event: Event) => {
      const item = (event as CustomEvent<MediaItem>).detail;
      setMedia((current) => mergeMediaItems([item], current));
      setMediaStatus("ready");
    };
    window.addEventListener(MEDIA_UPLOADED_EVENT, uploaded);
    return () => window.removeEventListener(MEDIA_UPLOADED_EVENT, uploaded);
  }, []);

  useEffect(() => {
    setDraft((current) => {
      if (!selectedId) {
        draftRef.current = null;
        return null;
      }
      if (current?.id === selectedId) return current;
      const selected = teams.find((team) => team.id === selectedId) || null;
      const next = selected ? structuredClone(selected) : null;
      draftRef.current = next;
      return next;
    });
  }, [selectedId, teams]);

  useEffect(() => {
    const debouncer = teamSaveDebouncerRef.current;
    teamsMountedRef.current = true;
    return () => {
      teamsMountedRef.current = false;
      debouncer?.flush();
    };
  }, []);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!hasPendingTeamSave()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function programmaticNavigation(event: Event) {
      if (!hasPendingTeamSave()) return;
      if (!window.confirm("Team changes are still saving. Leave this page anyway?")) event.preventDefault();
    }
    function allowNavigation() {
      if (hasPendingTeamSave()) allowNextNavigationRef.current = true;
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(PROGRAMMATIC_NAVIGATION_EVENT, programmaticNavigation);
    window.addEventListener(ALLOW_PROGRAMMATIC_NAVIGATION_EVENT, allowNavigation);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(PROGRAMMATIC_NAVIGATION_EVENT, programmaticNavigation);
      window.removeEventListener(ALLOW_PROGRAMMATIC_NAVIGATION_EVENT, allowNavigation);
    };
  }, [hasPendingTeamSave]);

  async function persistTeam(team: TeamLibraryEntry, revision: number) {
    if (conflictedTeamIdsRef.current.has(team.id) || latestTeamSaveRevisionRef.current[team.id] !== revision) return;
    if (teamsMountedRef.current) setSaveStatuses((current) => ({ ...current, [team.id]: "saving" }));
    try {
      const expectedRevision = serverTeamRevisionRef.current[team.id] ?? team.revision;
      const response = await teamApi.patch(team.id, { ...team, revision: expectedRevision });
      serverTeamRevisionRef.current[team.id] = response.team.revision;
      if (!teamsMountedRef.current || latestTeamSaveRevisionRef.current[response.team.id] !== revision) return;
      pendingTeamIdsRef.current.delete(response.team.id);
      teamsRef.current = teamsRef.current.map((item) => (item.id === response.team.id ? response.team : item));
      setTeams(teamsRef.current);
      setDraft((current) => {
        if (current?.id !== response.team.id) return current;
        const next = structuredClone(response.team);
        draftRef.current = next;
        return next;
      });
      setSaveStatuses((current) => ({ ...current, [response.team.id]: "saved" }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        conflictedTeamIdsRef.current.add(team.id);
        if (teamsMountedRef.current) {
          setSaveStatuses((current) => ({ ...current, [team.id]: "error" }));
          setError("This team changed in another tab. Reload the page before continuing so you do not overwrite newer changes.");
        }
        return;
      }
      if (!teamsMountedRef.current || latestTeamSaveRevisionRef.current[team.id] !== revision) return;
      setSaveStatuses((current) => ({ ...current, [team.id]: "error" }));
      setError(err instanceof Error ? err.message : "Could not autosave team");
    }
  }

  function enqueueTeamSave(team: TeamLibraryEntry, revision: number) {
    void teamSaveQueueRef.current?.run(team.id, () => persistTeam(team, revision));
  }

  function retryTeamSave() {
    const team = draftRef.current;
    if (!team || conflictedTeamIdsRef.current.has(team.id) || !pendingTeamIdsRef.current.has(team.id)) return;
    const revision = latestTeamSaveRevisionRef.current[team.id];
    if (revision === undefined) return;
    setError(null);
    setSaveStatuses((current) => ({ ...current, [team.id]: "saving" }));
    teamSaveDebouncerRef.current?.cancel(team.id);
    enqueueTeamSave(structuredClone(team), revision);
  }

  function discardTeamEdits() {
    if (pendingTeamIdsRef.current.size > 0 && !window.confirm("Discard unsaved team edits and reload saved teams?")) return;
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not reload teams"));
  }

  async function createTeam() {
    const name = await prompt({
      title: "New team",
      label: "Team name",
      defaultValue: "New Team",
      submitLabel: "Create team"
    });
    const trimmedName = name?.trim();
    if (!trimmedName) return;
    const displayName = titleCaseFirst(trimmedName);
    setError(null);
    // An in-flight library load must not select an older team while this
    // creation is pending. The new team becomes the active editor on success.
    loadGenerationRef.current += 1;
    try {
      const response = await teamApi.create({
        fullName: displayName,
        shortName: makeAbbreviation(displayName),
        abbreviation: makeAbbreviation(displayName)
      });
      teamsRef.current = [response.team, ...teamsRef.current];
      serverTeamRevisionRef.current[response.team.id] = response.team.revision;
      const nextDraft = structuredClone(response.team);
      selectedIdRef.current = response.team.id;
      draftRef.current = nextDraft;
      setLoading(false);
      setTeams(teamsRef.current);
      setSelectedId(response.team.id);
      setDraft(nextDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create team");
    }
  }

  function updateDraft(teamId: string, patch: Partial<SoccerState["home"]>) {
    if (conflictedTeamIdsRef.current.has(teamId)) {
      setError("This team changed in another tab. Reload the page before continuing so you do not overwrite newer changes.");
      return;
    }
    setError(null);
    const current = draftRef.current?.id === teamId ? draftRef.current : teamsRef.current.find((team) => team.id === teamId);
    if (!current) return;
    loadGenerationRef.current += 1;
    const next = mergeTeamPatch(current, patch);
    draftRef.current = draftRef.current?.id === teamId ? next : draftRef.current;
    teamsRef.current = teamsRef.current.map((team) => (team.id === teamId ? next : team));
    setDraft((selected) => (selected?.id === teamId ? next : selected));
    setTeams(teamsRef.current);
    const revision = teamSaveRevisionRef.current + 1;
    teamSaveRevisionRef.current = revision;
    latestTeamSaveRevisionRef.current[teamId] = revision;
    pendingTeamIdsRef.current.add(teamId);
    setSaveStatuses((statuses) => ({ ...statuses, [teamId]: "saving" }));
    teamSaveDebouncerRef.current?.schedule(teamId, () => enqueueTeamSave(next, revision));
  }

  async function deleteTeam(id: string) {
    if (conflictedTeamIdsRef.current.has(id)) return;
    const target = teamsRef.current.find((team) => team.id === id);
    if (!target) {
      setError("Could not delete a team that is no longer in the loaded library.");
      return;
    }
    if (!window.confirm(`Delete ${target?.fullName || "this team"}?`)) return;
    const pendingSnapshot = pendingTeamIdsRef.current.has(id) ? structuredClone(draftRef.current?.id === id ? draftRef.current : (target ?? null)) : null;
    setError(null);
    try {
      loadGenerationRef.current += 1;
      teamSaveDebouncerRef.current?.cancel(id);
      conflictedTeamIdsRef.current.add(id);
      setDeletingTeamIds((current) => new Set(current).add(id));
      latestTeamSaveRevisionRef.current[id] = teamSaveRevisionRef.current + 1;
      teamSaveRevisionRef.current += 1;
      await teamSaveQueueRef.current!.run(id, () => teamApi.remove(id, serverTeamRevisionRef.current[id] ?? target.revision));
      pendingTeamIdsRef.current.delete(id);
      conflictedTeamIdsRef.current.delete(id);
      const remaining = teamsRef.current.filter((team) => team.id !== id);
      delete serverTeamRevisionRef.current[id];
      teamsRef.current = remaining;
      if (selectedIdRef.current === id) selectedIdRef.current = remaining[0]?.id ?? null;
      setTeams(remaining);
      setSelectedId(selectedIdRef.current);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        conflictedTeamIdsRef.current.add(id);
        if (pendingSnapshot) pendingTeamIdsRef.current.add(id);
        setSaveStatuses((statuses) => ({ ...statuses, [id]: "error" }));
        setError("This team changed in another tab before it could be deleted. Reload teams and review the latest version.");
      } else if (pendingSnapshot) {
        conflictedTeamIdsRef.current.delete(id);
        const retryRevision = teamSaveRevisionRef.current + 1;
        teamSaveRevisionRef.current = retryRevision;
        latestTeamSaveRevisionRef.current[id] = retryRevision;
        pendingTeamIdsRef.current.add(id);
        setSaveStatuses((statuses) => ({ ...statuses, [id]: "saving" }));
        teamSaveDebouncerRef.current?.schedule(id, () => enqueueTeamSave(pendingSnapshot, retryRevision));
        setError(err instanceof Error ? err.message : "Could not delete team");
      } else {
        conflictedTeamIdsRef.current.delete(id);
        setError(err instanceof Error ? err.message : "Could not delete team");
      }
    } finally {
      if (teamsMountedRef.current)
        setDeletingTeamIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
    }
  }

  return (
    <div className="teams-page">
      <div className="page-title">
        <h1>Teams</h1>
      </div>
      {error ? (
        <div className="error" role="alert">
          <span>{error}</span>
          {draft && pendingTeamIdsRef.current.has(draft.id) && !conflictedTeamIdsRef.current.has(draft.id) ? (
            <button className="button" type="button" onClick={retryTeamSave}>
              Retry save
            </button>
          ) : null}
          <button className="button" type="button" onClick={discardTeamEdits}>
            {pendingTeamIdsRef.current.size ? "Discard edits and reload" : "Retry loading"}
          </button>
        </div>
      ) : null}
      {mediaStatus === "loading" ? (
        <p className="muted" role="status">
          Loading saved logos…
        </p>
      ) : null}
      {mediaStatus === "ready" && media.length === 0 ? <p className="muted">No saved logos yet.</p> : null}
      {mediaStatus === "failed" ? (
        <div className="error" role="alert">
          Saved logos could not be loaded.{" "}
          <button className="button" type="button" onClick={() => void retryMedia()}>
            Retry logos
          </button>
        </div>
      ) : null}
      <div className={`team-library-layout ${draft || loading ? "" : "empty"}`}>
        <section className="team-list">
          <button
            type="button"
            className="team-list-item team-list-item-new"
            style={
              {
                "--team-primary": "var(--sw-red)",
                "--team-secondary": "color-mix(in srgb, var(--sw-bg) 82%, white 18%)"
              } as React.CSSProperties
            }
            onClick={() => void createTeam()}
          >
            <span className="team-list-item-icon" aria-hidden="true">
              <Plus size={20} />
            </span>
            <strong>New Team</strong>
          </button>
          {loading ? <TeamListSkeleton /> : null}
          {teams.map((team) => (
            <button
              key={team.id}
              className={`team-list-item ${team.id === selectedId ? "active" : ""}`}
              style={
                {
                  "--team-primary": team.primaryColor,
                  "--team-secondary": team.secondaryColor
                } as React.CSSProperties
              }
              onClick={() => {
                selectedIdRef.current = team.id;
                setSelectedId(team.id);
              }}
            >
              <TeamLogo team={team} />
              <span>
                <strong>{titleCaseFirst(team.fullName)}</strong>
                <small>
                  {team.abbreviation} · {formatRecord(team.record)}
                </small>
              </span>
            </button>
          ))}
        </section>
        {loading && !draft ? <TeamEditorSkeleton /> : null}
        {draft ? (
          <section
            className="panel team-editor-panel"
            inert={conflictedTeamIdsRef.current.has(draft.id)}
            aria-disabled={conflictedTeamIdsRef.current.has(draft.id)}
          >
            <div className="panel-heading">
              <div>
                <h2>{titleCaseFirst(draft.fullName)}</h2>
              </div>
              <div className="control-row">
                <button className="button danger" disabled={conflictedTeamIdsRef.current.has(draft.id)} onClick={() => void deleteTeam(draft.id)}>
                  <Trash2 size={17} /> {deletingTeamIds.has(draft.id) ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
            <TeamFields key={draft.id} team={draft} media={media} onChange={(patch) => updateDraft(draft.id, patch)} />
            <p className="muted autosave-status" role="status">
              {deletingTeamIds.has(draft.id) ? "Deleting team..." : saveStatusLabel(saveStatuses[draft.id] ?? "idle", draft.updatedAt)}
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function PresetEditor() {
  const { presetId } = useParams();
  const user = useContext(AuthContext)?.user;
  const userId = user?.id;
  const navigate = useNavigate();
  const prompt = usePromptDialog();
  const [preset, setPreset] = useState<PresetSummary | null>(null);
  // Keep the receipt anchor mounted across control-tab changes.
  const controlTimeMs = useControlTime(preset?.serverTimeMs, null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [teams, setTeams] = useState<TeamLibraryEntry[]>([]);
  const [optionalCatalogStatus, setOptionalCatalogStatus] = useState<{ media: "loading" | "ready" | "failed"; teams: "loading" | "ready" | "failed" }>({
    media: "loading",
    teams: "loading"
  });
  const [tab, setTab] = useState("live");
  const [soccerPreviewSurface, setSoccerPreviewSurface] = useState<SoccerState["soccerPackage"]["surface"]>("checker");
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [showConnectionWarning, setShowConnectionWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presetDeleted, setPresetDeleted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [debugEvents, setDebugEvents] = useState<PresetEvent[] | null>(null);
  const [history, setHistory] = useState<PresetState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pendingSoccerTextUpdate, setPendingSoccerTextUpdate] = useState<{ state: SoccerState; fields: SoccerTextAnimationField[] } | null>(null);
  const pendingSoccerTextUpdateRef = useRef<{ state: SoccerState; fields: SoccerTextAnimationField[] } | null>(null);
  const presetRef = useRef<PresetSummary | null>(null);
  const mutationBroadcastRef = useRef<PresetSummary | null>(null);
  const bufferedSocketPresetRef = useRef<{ generation: number; preset: PresetSummary } | null>(null);
  const presetLoadControllerRef = useRef<AbortController | null>(null);
  const historyRef = useRef<PresetState[]>([]);
  const historyIndexRef = useRef(-1);
  const routeGenerationRef = useRef(0);
  const localSaveSequenceRef = useRef(0);
  const latestSaveSequenceByPresetRef = useRef<Record<string, number>>({});
  const serverRevisionByPresetRef = useRef<Record<string, number>>({});
  const hasPendingPresetSaveRef = useRef(false);
  const autosaveFailedRef = useRef(false);
  const mutationBusyRef = useRef(false);
  const allowNextNavigationRef = useRef(false);
  const mutationQueueRef = useRef<DebouncedSerialMutationQueue | null>(null);
  if (!mutationQueueRef.current) mutationQueueRef.current = new DebouncedSerialMutationQueue(180);

  const replacePreset = useCallback((next: PresetSummary | null) => {
    presetRef.current = next;
    setPreset(next);
  }, []);

  const resetHistory = useCallback((state: PresetState) => {
    const next = [structuredClone(state)];
    historyRef.current = next;
    historyIndexRef.current = 0;
    setHistory(next);
    setHistoryIndex(0);
  }, []);

  const requireSavedState = useCallback(() => {
    if (!autosaveFailedRef.current) return true;
    setError("Unsaved game changes must be saved before running this operation. Retry the save or make another edit first.");
    return false;
  }, []);

  const hasUnsavedWork = useCallback(
    () => Boolean(pendingSoccerTextUpdateRef.current || hasPendingPresetSaveRef.current || autosaveFailedRef.current || mutationBusyRef.current),
    []
  );
  useUnsavedNavigationBlocker(hasUnsavedWork, allowNextNavigationRef, "This game still has unsaved or staged changes. Leave without waiting for them?");

  const appendHistory = useCallback((state: PresetState) => {
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    const next = [...trimmed, structuredClone(state)].slice(-60);
    const nextIndex = next.length - 1;
    historyRef.current = next;
    historyIndexRef.current = nextIndex;
    setHistory(next);
    setHistoryIndex(nextIndex);
  }, []);

  const selectedElement = useMemo(() => {
    if (!preset) return undefined;
    if (isSoccerState(preset.state)) return undefined;
    if (isChurchState(preset.state)) return preset.state.elements.lowerThird;
    return undefined;
  }, [preset]);

  useEffect(() => {
    const uploaded = (event: Event) => {
      const item = (event as CustomEvent<MediaItem>).detail;
      setMedia((current) => mergeMediaItems([item], current));
      setOptionalCatalogStatus((current) => ({ ...current, media: "ready" }));
    };
    window.addEventListener(MEDIA_UPLOADED_EVENT, uploaded);
    return () => window.removeEventListener(MEDIA_UPLOADED_EVENT, uploaded);
  }, []);

  useEffect(() => {
    if (!presetId) return;
    const requestedPresetId = presetId;
    const generation = routeGenerationRef.current + 1;
    routeGenerationRef.current = generation;
    const controller = new AbortController();
    presetLoadControllerRef.current = controller;
    mutationBusyRef.current = false;
    setMutationBusy(false);
    setRevisionConflict(false);
    setAutosaveFailed(false);
    autosaveFailedRef.current = false;
    setNotice(null);
    setActionKey(userId ? (pendingActionKeys.get(`${userId}:${requestedPresetId}`) ?? null) : null);
    setDebugEvents(null);
    setError(null);
    setPresetDeleted(false);
    // A returning page can paint its last state immediately. Its HTTP request
    // and realtime subscription refresh it without another skeleton.
    if (presetRef.current?.id !== requestedPresetId) {
      replacePreset(null);
      setMedia([]);
      setTeams([]);
      setOptionalCatalogStatus({ media: "loading", teams: "loading" });
    }
    const loadSaveSequence = localSaveSequenceRef.current;
    setPendingSoccerTextUpdate(null);
    pendingSoccerTextUpdateRef.current = null;
    bufferedSocketPresetRef.current = null;
    mutationBroadcastRef.current = null;
    setConnection("connecting");
    hasPendingPresetSaveRef.current = false;
    void mutationQueueRef.current?.flush().catch(() => undefined);

    async function loadPreset() {
      const optionalResults = Promise.allSettled([mediaApi.list(controller.signal), teamApi.list(controller.signal)]);
      const presetResult = await presetApi.get(requestedPresetId, controller.signal);
      if (controller.signal.aborted || routeGenerationRef.current !== generation) return;

      const fetchedPreset = presetResult.preset;
      const buffered = bufferedSocketPresetRef.current?.generation === generation ? bufferedSocketPresetRef.current.preset : null;
      const fetchedRevision = getPresetRevision(fetchedPreset) ?? -1;
      const bufferedRevision = buffered ? (getPresetRevision(buffered) ?? Number.MAX_SAFE_INTEGER) : -1;
      const loadedPreset = buffered && bufferedRevision >= fetchedRevision ? buffered : fetchedPreset;
      bufferedSocketPresetRef.current = null;
      const current = presetRef.current;
      const localChangeDuringLoad =
        localSaveSequenceRef.current !== loadSaveSequence ||
        hasPendingPresetSaveRef.current ||
        mutationBusyRef.current ||
        pendingSoccerTextUpdateRef.current ||
        autosaveFailedRef.current;
      // A cached editor remains usable during refresh. Late HTTP must not
      // overwrite an edit or a newer realtime snapshot received meanwhile.
      if (!localChangeDuringLoad && (!current || loadedPreset.revision >= current.revision)) {
        replacePreset(loadedPreset);
        if (!current || loadedPreset.revision !== current.revision) resetHistory(loadedPreset.state);
        const serverRevision = getPresetRevision(loadedPreset);
        if (serverRevision !== undefined) serverRevisionByPresetRef.current[loadedPreset.id] = serverRevision;
      }
      const [mediaResult, teamsResult] = await optionalResults;
      if (controller.signal.aborted || routeGenerationRef.current !== generation) return;
      if (mediaResult.status === "fulfilled") setMedia((current) => mergeMediaItems(mediaResult.value.media, current));
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value.teams);
      setOptionalCatalogStatus({
        media: mediaResult.status === "fulfilled" ? "ready" : "failed",
        teams: teamsResult.status === "fulfilled" ? "ready" : "failed"
      });
    }

    void loadPreset().catch((err) => {
      if (controller.signal.aborted || routeGenerationRef.current !== generation) return;
      setError(err instanceof Error ? err.message : "Could not load game");
    });

    return () => {
      controller.abort();
      if (presetLoadControllerRef.current === controller) presetLoadControllerRef.current = null;
      if (routeGenerationRef.current === generation) routeGenerationRef.current += 1;
      setPendingSoccerTextUpdate(null);
      pendingSoccerTextUpdateRef.current = null;
      bufferedSocketPresetRef.current = null;
      void mutationQueueRef.current?.flush().catch(() => undefined);
    };
  }, [presetId, reloadKey, replacePreset, resetHistory, userId]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function programmaticNavigation(event: Event) {
      if (!hasUnsavedWork()) return;
      if (!window.confirm("This game still has unsaved or staged changes. Leave without waiting for them?")) event.preventDefault();
    }
    function allowNavigation() {
      if (hasUnsavedWork()) allowNextNavigationRef.current = true;
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(PROGRAMMATIC_NAVIGATION_EVENT, programmaticNavigation);
    window.addEventListener(ALLOW_PROGRAMMATIC_NAVIGATION_EVENT, allowNavigation);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(PROGRAMMATIC_NAVIGATION_EVENT, programmaticNavigation);
      window.removeEventListener(ALLOW_PROGRAMMATIC_NAVIGATION_EVENT, allowNavigation);
    };
  }, [hasUnsavedWork]);

  useEffect(() => {
    if (!preset) return;
    if (preset.type === "soccer" && !defaultSoccerEditorTabs.includes(tab as SoccerEditorTab)) setTab("live");
    if (preset.type !== "soccer" && !["slides", "style"].includes(tab)) setTab("slides");
  }, [preset, tab]);

  useEffect(() => {
    const current = presetRef.current;
    if (current?.state && isSoccerState(current.state)) {
      setSoccerPreviewSurface(current.state.soccerPackage.surface);
    }
  }, [preset?.id]);

  useEffect(() => {
    if (!presetId) return;
    const requestedPresetId = presetId;
    const generation = routeGenerationRef.current;
    const socket = io(WS_URL, {
      autoConnect: false,
      withCredentials: true,
      transports: ["polling", "websocket"],
      tryAllTransports: true,
      auth: { role: "admin", presetId, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION },
      query: { role: "admin", presetId, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
    });
    const retry = new RealtimeRetry(() => socket.connect());
    let disposed = false;
    // Strict Mode cleans up its probe mount synchronously. Do not leave an
    // orphan polling handshake behind for a subscription that never mounted.
    queueMicrotask(() => {
      if (!disposed) socket.connect();
    });
    function enterDeletedState(explicitPayload?: PresetDeletedEvent) {
      if (routeGenerationRef.current !== generation) return;
      const current = presetRef.current;
      const sidebarPayload =
        explicitPayload ?? (current && current.id === requestedPresetId ? { id: current.id, publicId: current.publicId, revision: current.revision } : null);

      // Invalidate any HTTP/autosave completion already in flight before
      // clearing the editor. Those requests may still settle, but they can no
      // longer resurrect the deleted record in this route's state.
      routeGenerationRef.current += 1;
      presetLoadControllerRef.current?.abort();
      presetLoadControllerRef.current = null;
      bufferedSocketPresetRef.current = null;
      pendingSoccerTextUpdateRef.current = null;
      hasPendingPresetSaveRef.current = false;
      autosaveFailedRef.current = false;
      mutationBusyRef.current = false;
      delete serverRevisionByPresetRef.current[requestedPresetId];
      replacePreset(null);
      historyRef.current = [];
      historyIndexRef.current = -1;
      setHistory([]);
      setHistoryIndex(-1);
      setPendingSoccerTextUpdate(null);
      setAutosaveFailed(false);
      setMutationBusy(false);
      setRevisionConflict(false);
      if (userId) pendingActionKeys.delete(`${userId}:${requestedPresetId}`);
      setActionKey(null);
      setDebugEvents(null);
      setNotice(null);
      setError(null);
      setPresetDeleted(true);
      setConnection("disconnected");
      if (sidebarPayload) dispatchPresetDeleted(sidebarPayload);
      retry.stop();
      socket.disconnect();
    }
    socket.on("connect", () => {
      if (routeGenerationRef.current === generation) setConnection("connected");
    });
    socket.on("disconnect", (reason) => {
      if (routeGenerationRef.current !== generation) return;
      setConnection("disconnected");
      retry.disconnected(reason);
    });
    socket.on("connect_error", () => {
      if (routeGenerationRef.current === generation) setConnection("disconnected");
    });
    socket.on("preset:update", (payload: unknown) => {
      if (routeGenerationRef.current !== generation) return;
      if (!isPreset(payload)) {
        setError("Ignored a malformed realtime game update.");
        return;
      }
      if (payload.id !== requestedPresetId) return;
      retry.receivedState();
      const current = presetRef.current;
      if (!current) {
        const buffered = bufferedSocketPresetRef.current;
        const bufferedRevision = buffered ? (getPresetRevision(buffered.preset) ?? -1) : -1;
        const incomingRevision = getPresetRevision(payload) ?? Number.MAX_SAFE_INTEGER;
        if (!buffered || buffered.generation !== generation || incomingRevision >= bufferedRevision) {
          bufferedSocketPresetRef.current = { generation, preset: payload };
        }
        return;
      }
      if (current.id !== payload.id) return;
      if (hasPendingPresetSaveRef.current || mutationBusyRef.current || autosaveFailedRef.current) {
        if (payload.revision < current.revision) return;
        mutationBroadcastRef.current = payload;
        replacePreset({ ...payload, state: current.state });
        return;
      }
      const serverRevision = getPresetRevision(payload);
      const knownRevision = serverRevisionByPresetRef.current[payload.id];
      if (serverRevision !== undefined && knownRevision !== undefined && serverRevision <= knownRevision) {
        replacePreset({ ...current, overlayClientCount: payload.overlayClientCount });
        return;
      }
      if (serverRevision !== undefined) serverRevisionByPresetRef.current[payload.id] = serverRevision;
      replacePreset(payload);
      resetHistory(payload.state);
    });
    socket.on("preset:deleted", (payload: unknown) => {
      if (routeGenerationRef.current !== generation) return;
      if (!isPresetDeletedEvent(payload)) {
        setError("Ignored a malformed realtime game deletion event.");
        return;
      }
      if (payload.id !== presetId) return;
      enterDeletedState(payload);
    });
    socket.on("error:message", (payload: unknown) => {
      if (routeGenerationRef.current !== generation || !isRealtimeErrorMessage(payload)) return;
      // The backend uses this exact role-specific message only when an
      // authenticated subscription resolves to no row. Other errors can be
      // transient, auth-related, or version-related and must retain last-known
      // state rather than being mistaken for deletion.
      if (payload.error === "Preset not found") enterDeletedState();
      if (payload.error === "Authentication required") {
        retry.stop();
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
      if (payload.error === "Incompatible OpenOverlay API or realtime version") {
        retry.stop();
        setError("Realtime version is incompatible. Reload OpenOverlay to use the latest version.");
      }
    });
    socket.on("overlay:clients", (payload: unknown) => {
      if (routeGenerationRef.current !== generation) return;
      const count = payload && typeof payload === "object" ? (payload as { count?: unknown }).count : undefined;
      if (!Number.isSafeInteger(count) || Number(count) < 0) return;
      const current = presetRef.current;
      if (!current || current.id !== presetId) return;
      replacePreset({ ...current, overlayClientCount: Number(count) });
    });
    return () => {
      disposed = true;
      retry.stop();
      socket.disconnect();
    };
  }, [presetId, reloadKey, replacePreset, resetHistory, userId]);

  useEffect(() => {
    if (connection !== "disconnected") {
      setShowConnectionWarning(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionWarning(true), 3000);
    return () => window.clearTimeout(timeout);
  }, [connection]);

  const reconcileMutation = useCallback((response: PresetSummary): PresetSummary => {
    const broadcast = mutationBroadcastRef.current;
    mutationBroadcastRef.current = null;
    return broadcast?.id === response.id && broadcast.revision > response.revision ? broadcast : response;
  }, []);

  const recoverMutationBroadcast = useCallback(() => {
    // A failed response does not imply a failed commit. A validated broadcast
    // is authoritative, except while an unsaved local draft still needs recovery.
    const broadcast = mutationBroadcastRef.current;
    if (autosaveFailedRef.current || !broadcast || broadcast.id !== presetRef.current?.id) return;
    mutationBroadcastRef.current = null;
    serverRevisionByPresetRef.current[broadcast.id] = broadcast.revision;
    replacePreset(broadcast);
    resetHistory(broadcast.state);
  }, [replacePreset, resetHistory]);

  const commitState = useCallback(
    (nextState: PresetState, persist = true) => {
      const current = presetRef.current;
      if (!current || mutationBusyRef.current || revisionConflict) return;
      const resourceId = current.id;
      const generation = routeGenerationRef.current;
      replacePreset({ ...current, state: nextState });
      appendHistory(nextState);
      if (persist) {
        autosaveFailedRef.current = false;
        setAutosaveFailed(false);
        const sequence = localSaveSequenceRef.current + 1;
        localSaveSequenceRef.current = sequence;
        latestSaveSequenceByPresetRef.current[resourceId] = sequence;
        hasPendingPresetSaveRef.current = true;
        mutationQueueRef.current?.schedule(resourceId, async () => {
          try {
            const response = await presetApi.patch(resourceId, {
              state: nextState,
              expectedRevision: serverRevisionByPresetRef.current[resourceId]
            });
            if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
            const serverRevision = getPresetRevision(response.preset);
            if (serverRevision !== undefined) serverRevisionByPresetRef.current[resourceId] = serverRevision;
            const newestSave = latestSaveSequenceByPresetRef.current[resourceId] === sequence;
            if (newestSave) hasPendingPresetSaveRef.current = false;
            const accepted = reconcileMutation(response.preset);
            const latest = presetRef.current;
            if (newestSave) {
              serverRevisionByPresetRef.current[resourceId] = accepted.revision;
              replacePreset(accepted);
              if (accepted.revision > response.preset.revision) resetHistory(accepted.state);
            } else if (latest) {
              // Keep the acknowledgement revision as the next save's precondition:
              // a concurrent operator update must conflict with this local draft.
              replacePreset({ ...accepted, state: latest.state });
            }
            autosaveFailedRef.current = false;
            setAutosaveFailed(false);
          } catch (err) {
            if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
            if (latestSaveSequenceByPresetRef.current[resourceId] === sequence) hasPendingPresetSaveRef.current = false;
            if (err instanceof ApiError && err.status === 409) {
              mutationBusyRef.current = true;
              setMutationBusy(true);
              setRevisionConflict(true);
              setError("This game changed in another tab. Reload the latest version before continuing.");
            } else {
              autosaveFailedRef.current = true;
              setAutosaveFailed(true);
              setError(err instanceof Error ? err.message : "Could not autosave game");
            }
            throw err;
          }
        });
      }
    },
    [appendHistory, reconcileMutation, replacePreset, resetHistory, revisionConflict]
  );

  const restoreHistory = useCallback(
    async (direction: "undo" | "redo") => {
      const current = presetRef.current;
      if (!current || mutationBusyRef.current || revisionConflict || !requireSavedState()) return;
      const resourceId = current.id;
      const generation = routeGenerationRef.current;
      const nextIndex = direction === "redo" ? Math.min(historyRef.current.length - 1, historyIndexRef.current + 1) : Math.max(0, historyIndexRef.current - 1);
      const nextState = historyRef.current[nextIndex];
      if (!nextState || nextIndex === historyIndexRef.current) return;
      const previousIndex = historyIndexRef.current;
      const previousState = structuredClone(current.state);
      pendingSoccerTextUpdateRef.current = null;
      setPendingSoccerTextUpdate(null);
      mutationBusyRef.current = true;
      setMutationBusy(true);
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
      replacePreset({ ...current, state: structuredClone(nextState) });
      hasPendingPresetSaveRef.current = true;
      let conflict = false;
      try {
        const response = await mutationQueueRef.current!.run(() =>
          presetApi.patch(resourceId, {
            state: nextState,
            expectedRevision: serverRevisionByPresetRef.current[resourceId]
          })
        );
        if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
        const accepted = reconcileMutation(response.preset);
        serverRevisionByPresetRef.current[resourceId] = accepted.revision;
        replacePreset(accepted);
        if (accepted.revision > response.preset.revision) resetHistory(accepted.state);
      } catch (err) {
        if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
        historyIndexRef.current = previousIndex;
        setHistoryIndex(previousIndex);
        const latest = presetRef.current;
        if (latest) replacePreset({ ...latest, state: previousState });
        if (err instanceof ApiError && err.status === 409) {
          conflict = true;
          setRevisionConflict(true);
          setError("This game changed in another tab. Reload the latest version before continuing.");
        } else {
          recoverMutationBroadcast();
          setError(err instanceof Error ? err.message : "Could not restore game history");
        }
      } finally {
        if (routeGenerationRef.current === generation && presetRef.current?.id === resourceId) {
          hasPendingPresetSaveRef.current = false;
          if (!conflict) {
            mutationBusyRef.current = false;
            setMutationBusy(false);
          }
        }
      }
    },
    [reconcileMutation, recoverMutationBroadcast, replacePreset, requireSavedState, resetHistory, revisionConflict]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z" || !presetRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      void restoreHistory(event.shiftKey ? "redo" : "undo");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [restoreHistory]);

  async function runAction(action: string, payload: Record<string, unknown> = {}) {
    if (!presetRef.current || mutationBusyRef.current || revisionConflict || !requireSavedState()) return;
    if (pendingSoccerTextUpdateRef.current) applyPendingSoccerTextUpdate();
    const current = presetRef.current;
    if (!current) return;
    const resourceId = current.id;
    const generation = routeGenerationRef.current;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    hasPendingPresetSaveRef.current = true;
    setError(null);
    let conflict = false;
    try {
      const response = await mutationQueueRef.current!.run(() => presetApi.action(resourceId, action, payload, serverRevisionByPresetRef.current[resourceId]));
      if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
      const accepted = reconcileMutation(response.preset);
      serverRevisionByPresetRef.current[resourceId] = accepted.revision;
      replacePreset(accepted);
      if (accepted.revision > response.preset.revision) resetHistory(accepted.state);
      else appendHistory(accepted.state);
    } catch (err) {
      if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
      if (err instanceof ApiError && err.status === 409) {
        conflict = true;
        setRevisionConflict(true);
        setError("This game changed in another tab. Reload the latest version before continuing.");
      } else {
        recoverMutationBroadcast();
        setError(err instanceof Error ? err.message : "Game action failed");
      }
    } finally {
      if (routeGenerationRef.current === generation && presetRef.current?.id === resourceId) {
        hasPendingPresetSaveRef.current = false;
        if (!conflict) {
          mutationBusyRef.current = false;
          setMutationBusy(false);
        }
      }
    }
  }

  if (presetDeleted) {
    return (
      <div className="live-game-page">
        <div className="error" role="alert">
          <h1>Production deleted</h1>
          <p>This production was deleted in another session. Its editor and output have been closed.</p>
          <Link className="button" to="/dash">
            Return to productions
          </Link>
        </div>
      </div>
    );
  }

  if (!preset || preset.id !== presetId) {
    if (!error || (preset && preset.id !== presetId)) return <PageSkeleton variant="editor" />;
    return (
      <div className="live-game-page">
        <div className="error" role="alert">
          <p>Could not load game: {error}</p>
          <button className="button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const overlayUrl = `${window.location.origin}/overlay/${preset.publicId}`;
  const soccerState = preset.type === "soccer" && isSoccerState(preset.state) ? preset.state : null;
  const tabs = soccerState ? defaultSoccerEditorTabs : ["slides", "style"];
  const isSoccerEditor = Boolean(soccerState);
  const tabLabels: Record<string, string> = { ...soccerTabLabels, slides: "Service", style: "Design" };
  const tabButtons = (
    <div className="tabs" role="group" aria-label="Editor sections">
      {tabs.map((item) => (
        <button
          key={item}
          className={`tab ${tab === item ? "active" : ""}`}
          data-soccer-tab={soccerState ? item : undefined}
          type="button"
          aria-pressed={tab === item}
          onClick={() => setTab(item)}
        >
          {tabLabels[item]}
        </button>
      ))}
    </div>
  );

  function updateSoccerClock(patch: Partial<SoccerState["clock"]>) {
    if (!soccerState) return;
    commitState({ ...soccerState, clock: { ...soccerState.clock, ...patch } });
  }

  function updateSoccerPackage(patch: Partial<SoccerState["soccerPackage"]>) {
    if (!soccerState) return;
    commitState({ ...soccerState, soccerPackage: { ...soccerState.soccerPackage, ...patch } });
  }

  function commitSoccerMatchState(nextState: SoccerState, changedFields: SoccerTextAnimationField[]) {
    const visibleFields = uniqueSoccerTextFields(
      changedFields.filter((field) => soccerTextFieldIsVisible(field, soccerState?.soccerPackage.activeOverlay ?? null, soccerState))
    );
    if (visibleFields.length > 0 || pendingSoccerTextUpdateRef.current) {
      commitState(nextState, false);
      setPendingSoccerTextUpdate((current) => ({
        state: nextState,
        fields: uniqueSoccerTextFields([...(current?.fields ?? []), ...visibleFields])
      }));
      const current = pendingSoccerTextUpdateRef.current;
      pendingSoccerTextUpdateRef.current = {
        state: nextState,
        fields: uniqueSoccerTextFields([...(current?.fields ?? []), ...visibleFields])
      };
      return;
    }
    commitState(nextState);
  }

  function updateSoccerMatchPackage(patch: Partial<SoccerState["soccerPackage"]>, changedFields: SoccerTextAnimationField[] = []) {
    if (!soccerState) return;
    commitSoccerMatchState({ ...soccerState, soccerPackage: { ...soccerState.soccerPackage, ...patch } }, changedFields);
  }

  function applyPendingSoccerTextUpdate() {
    const pendingUpdate = pendingSoccerTextUpdateRef.current;
    if (!pendingUpdate) return;
    const nextState: SoccerState = {
      ...pendingUpdate.state,
      soccerPackage: {
        ...pendingUpdate.state.soccerPackage,
        textAnimation: {
          id: Date.now(),
          fields: pendingUpdate.fields
        }
      }
    };
    pendingSoccerTextUpdateRef.current = null;
    setPendingSoccerTextUpdate(null);
    commitState(nextState);
  }

  async function duplicatePreset() {
    const current = presetRef.current;
    if (!current || mutationBusyRef.current || revisionConflict || !requireSavedState()) return;
    const generation = routeGenerationRef.current;
    if (pendingSoccerTextUpdateRef.current) applyPendingSoccerTextUpdate();
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setError(null);
    try {
      const response = await mutationQueueRef.current!.run(() => presetApi.duplicate(current.id));
      if (routeGenerationRef.current !== generation || presetRef.current?.id !== current.id) return;
      allowNextNavigationRef.current = true;
      void navigate(`/dash/presets/${response.preset.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not duplicate game");
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }

  async function sharePreset() {
    const current = presetRef.current;
    if (!current || mutationBusyRef.current || revisionConflict || !requireSavedState()) return;
    const email = (
      await prompt({
        title: "Share game",
        label: "Recipient account email",
        placeholder: "operator@example.com",
        inputType: "email",
        submitLabel: "Share copy"
      })
    )?.trim();
    if (!email) return;
    if (!requireSavedState()) return;
    if (pendingSoccerTextUpdateRef.current) applyPendingSoccerTextUpdate();
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setError(null);
    setNotice(null);
    try {
      await mutationQueueRef.current!.run(() => presetApi.share(current.id, email));
      setNotice(`A copy was shared with ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share game");
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }

  async function rotateActionKey() {
    const current = presetRef.current;
    if (!current || mutationBusyRef.current || revisionConflict || !requireSavedState()) return;
    if (!window.confirm("Rotate the action key? Existing Stream Deck and automation keys will stop working immediately.")) return;
    if (pendingSoccerTextUpdateRef.current) applyPendingSoccerTextUpdate();
    const generation = routeGenerationRef.current;
    const keyScope = `${userId ?? ""}:${current.id}`;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await mutationQueueRef.current!.run(() => presetApi.actionKey(current.id));
      pendingActionKeys.set(keyScope, response.actionKey);
      if (routeGenerationRef.current !== generation || presetRef.current?.id !== current.id) return;
      if (response.preset) {
        const revision = getPresetRevision(response.preset);
        if (revision !== undefined) serverRevisionByPresetRef.current[current.id] = revision;
        replacePreset(response.preset);
      }
      setActionKey(response.actionKey);
    } catch (err) {
      if (routeGenerationRef.current === generation && presetRef.current?.id === current.id)
        setError(err instanceof Error ? err.message : "Could not rotate action key");
    } finally {
      if (routeGenerationRef.current === generation && presetRef.current?.id === current.id) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  }

  async function retryOptionalCatalog(kind: "media" | "teams") {
    const generation = routeGenerationRef.current;
    const resourceId = presetRef.current?.id;
    if (!resourceId) return;
    setOptionalCatalogStatus((current) => ({ ...current, [kind]: "loading" }));
    try {
      if (kind === "media") {
        const response = await mediaApi.list();
        if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
        setMedia((current) => mergeMediaItems(response.media, current));
      } else {
        const response = await teamApi.list();
        if (routeGenerationRef.current !== generation || presetRef.current?.id !== resourceId) return;
        setTeams(response.teams);
      }
      setOptionalCatalogStatus((current) => ({ ...current, [kind]: "ready" }));
    } catch {
      if (routeGenerationRef.current === generation && presetRef.current?.id === resourceId)
        setOptionalCatalogStatus((current) => ({ ...current, [kind]: "failed" }));
    }
  }

  async function loadDebugEvents() {
    const current = presetRef.current;
    if (!current) return;
    setError(null);
    try {
      const response = await mutationQueueRef.current!.run(() => presetApi.events(current.id));
      if (presetRef.current?.id === current.id) setDebugEvents(response.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load event log");
    }
  }

  function retryCurrentSave() {
    const current = presetRef.current;
    if (!current || revisionConflict) return;
    setError(null);
    setAutosaveFailed(false);
    commitState(structuredClone(current.state));
  }

  return (
    <div className={`live-game-page ${preset.type === "church" ? "church-page" : ""}`}>
      <div className="page-title compact">
        <div>
          <h1>{preset.name}</h1>
          <p className="muted preset-meta">
            <span>{preset.type === "soccer" ? "soccer game" : `${preset.type} production`}</span>
            <CopyButton value={overlayUrl} className="inline-copy-button" onError={setError} />
          </p>
        </div>
        <div className="status-row">
          <span className={`status-pill ${connection === "connected" ? "ok" : "warn"}`}>{connection}</span>
          <span className="status-pill ok">{formatOverlayClientCount(preset.overlayClientCount || 0)}</span>
          <span className={`status-pill ${autosaveFailed || revisionConflict ? "warn" : "ok"}`} role="status">
            {autosaveFailed || revisionConflict ? "Unsaved changes" : hasPendingPresetSaveRef.current || mutationBusy ? "Saving…" : "Saved"}
          </span>
          <button className="button" type="button" disabled={mutationBusy || autosaveFailed || historyIndex <= 0} onClick={() => void restoreHistory("undo")}>
            Undo
          </button>
          <button
            className="button"
            type="button"
            disabled={mutationBusy || autosaveFailed || historyIndex >= history.length - 1}
            onClick={() => void restoreHistory("redo")}
          >
            Redo
          </button>
        </div>
      </div>

      <div className="control-row editor-tools" aria-label={preset.type === "church" ? "Service tools" : "Game tools"}>
        <a className="button" href={`/overlay-test/${preset.publicId}`} target="_blank" rel="noreferrer">
          <ExternalLink size={15} /> Test output
        </a>
        <ActionMenu label={preset.type === "church" ? "Service actions" : "Game actions"}>
          <button className="button" type="button" disabled={mutationBusy || revisionConflict || autosaveFailed} onClick={() => void duplicatePreset()}>
            <Copy size={15} /> Duplicate
          </button>
          <button className="button" type="button" disabled={mutationBusy || revisionConflict || autosaveFailed} onClick={() => void sharePreset()}>
            <Share2 size={15} /> Share
          </button>
          <button className="button" type="button" disabled={mutationBusy || revisionConflict || autosaveFailed} onClick={() => void rotateActionKey()}>
            <KeyRound size={15} /> Rotate action key
          </button>
          <button className="button" type="button" onClick={() => (debugEvents ? setDebugEvents(null) : void loadDebugEvents())}>
            <Bug size={15} /> {debugEvents ? "Hide events" : "Event log"}
          </button>
        </ActionMenu>
        <button className="button danger" type="button" disabled={mutationBusy || revisionConflict || autosaveFailed} onClick={() => void runAction("clear")}>
          <ShieldAlert size={15} /> Panic clear
        </button>
      </div>

      {preset.type === "church" ? <StageLinkControls presetId={preset.id} publicId={preset.publicId} onError={setError} /> : null}

      {optionalCatalogStatus.media === "loading" ? (
        <p className="muted" role="status">
          Loading media library…
        </p>
      ) : null}
      {optionalCatalogStatus.media === "ready" && media.length === 0 ? <p className="muted">No saved media yet.</p> : null}
      {optionalCatalogStatus.media === "failed" ? (
        <div className="error" role="alert">
          Media library could not be loaded.{" "}
          <button className="button" type="button" onClick={() => void retryOptionalCatalog("media")}>
            Retry media
          </button>
        </div>
      ) : null}
      {preset.type === "soccer" && optionalCatalogStatus.teams === "loading" ? (
        <p className="muted" role="status">
          Loading saved teams…
        </p>
      ) : null}
      {preset.type === "soccer" && optionalCatalogStatus.teams === "ready" && teams.length === 0 ? <p className="muted">No saved teams yet.</p> : null}
      {preset.type === "soccer" && optionalCatalogStatus.teams === "failed" ? (
        <div className="error" role="alert">
          Saved teams could not be loaded.{" "}
          <button className="button" type="button" onClick={() => void retryOptionalCatalog("teams")}>
            Retry teams
          </button>
        </div>
      ) : null}

      {showConnectionWarning ? (
        <div className="error" role="alert">
          Backend or overlay WebSocket is disconnected. The overlay will keep showing its last known state.
        </div>
      ) : null}
      {preset.stateRecovered ? (
        <div className="error" role="alert">
          Stored state was corrupt and a safe default was loaded. Review this game before going live, then save to replace the damaged state.
        </div>
      ) : null}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          <span>{error}</span>
          {revisionConflict ? (
            <button className="button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
              Reload latest
            </button>
          ) : null}
          {autosaveFailed && !revisionConflict ? (
            <button className="button" type="button" onClick={retryCurrentSave}>
              Retry save
            </button>
          ) : null}
        </div>
      ) : null}
      {actionKey ? (
        <div className="notice action-key-notice" role="status">
          <span>
            <strong>New action key:</strong> <code>{actionKey}</code>. Copy it now; it will not be shown again.
          </span>
          <button
            className="button"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(actionKey)
                .then(() => {
                  pendingActionKeys.delete(`${userId ?? ""}:${preset.id}`);
                  setNotice("Action key copied.");
                })
                .catch(() => setError("Could not copy action key."))
            }
          >
            <Copy size={14} /> Copy key
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              pendingActionKeys.delete(`${userId ?? ""}:${preset.id}`);
              setActionKey(null);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {debugEvents ? <PresetEventLog events={debugEvents} onRefresh={() => void loadDebugEvents()} /> : null}
      <span className="visually-hidden" role="status">
        {mutationBusy ? "Saving game" : "Game controls ready"}
      </span>

      <div
        className={`editor-layout ${isSoccerEditor ? "live-editor-layout" : preset.type === "church" ? "church-editor-layout" : ""}`}
        inert={mutationBusy}
        aria-busy={mutationBusy}
      >
        {preset.type === "church" && isChurchState(preset.state) ? (
          <div className="church-editor-content">
            {tabButtons}
            <ChurchControls
              state={preset.state}
              serverTimeMs={controlTimeMs}
              media={media}
              tab={tab}
              commitState={commitState}
              runAction={runAction}
              outputUrl={overlayUrl}
              disabled={mutationBusy || revisionConflict || autosaveFailed}
            />
            {tab === "style" && selectedElement ? <ElementInspector state={preset.state} element={selectedElement} commitState={commitState} /> : null}
          </div>
        ) : soccerState ? (
          <>
            <SoccerLabOverlayControls
              state={soccerState}
              updatePackage={updateSoccerPackage}
              runAction={runAction}
              onSelect={(overlay) => setTab(overlay === "full-matchup" || overlay === "lower-matchup" ? "match" : "live")}
            />
            <section className="preview-column live-preview-pane">
              <OutputPreviewFrame src={overlayUrl} title={`${preset.name} output preview`} surface={soccerPreviewSurface} />
              {pendingSoccerTextUpdate ? <SoccerPreviewUpdatePrompt onApply={applyPendingSoccerTextUpdate} /> : null}
            </section>
            <SoccerBottomControlPanel
              key={preset.id}
              state={soccerState}
              serverTimeMs={controlTimeMs}
              media={media}
              teams={teams}
              activeTab={tab}
              tabButtons={tabButtons}
              updateClock={updateSoccerClock}
              updatePackage={updateSoccerPackage}
              updateMatchPackage={updateSoccerMatchPackage}
              previewSurface={soccerPreviewSurface}
              setPreviewSurface={setSoccerPreviewSurface}
              commitMatchState={commitSoccerMatchState}
              runAction={runAction}
            />
          </>
        ) : (
          <>
            <section className="preview-column">
              <div className="preview-workspace">
                <OutputPreviewFrame src={overlayUrl} title={`${preset.name} output preview`} surface={soccerPreviewSurface} />
              </div>
            </section>
            <aside className="inspector">
              {tabButtons}
              {preset.type === "custom" ? (
                <div className="notice" role="status">
                  Custom presets are read-only in this release. Existing output data is preserved.
                </div>
              ) : null}
              {selectedElement ? (
                <details className="advanced-section">
                  <summary>Lower third layout</summary>
                  <ElementInspector state={preset.state} element={selectedElement} commitState={commitState} />
                </details>
              ) : null}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

function OutputPreviewFrame({ src, title, surface }: { src: string; title: string; surface: SoccerState["soccerPackage"]["surface"] }) {
  const [expanded, setExpanded] = useState(() => !(window.matchMedia?.("(max-width: 760px)").matches ?? false));
  return (
    <details className="preview-disclosure" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Output preview</summary>
      <div className={`preview-frame preview-surface-${surface}`}>
        <iframe className="output-preview-iframe" src={previewOverlaySrc(src)} title={title} loading="eager" />
      </div>
    </details>
  );
}

function PresetEventLog({ events, onRefresh }: { events: PresetEvent[]; onRefresh: () => void }) {
  return (
    <section className="panel event-log-panel" aria-label="Preset event log">
      <div className="panel-heading">
        <div>
          <h2>Event log</h2>
          <p className="muted">Latest {events.length} persisted game events.</p>
        </div>
        <button className="button" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {events.length ? (
        <ol className="event-log-list">
          {events.map((event) => (
            <li key={event.id}>
              <span>
                <strong>{event.type}</strong>
                <time dateTime={event.created_at}>{formatEventTime(event.created_at)}</time>
              </span>
              <code>{formatEventPayload(event.payload_json)}</code>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No events have been recorded for this game.</p>
      )}
    </section>
  );
}

function formatEventPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload) as unknown);
  } catch {
    return payload;
  }
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function previewOverlaySrc(src: string): string {
  const url = new URL(src, window.location.origin);
  url.searchParams.set("client", "preview");
  return url.toString();
}

function SoccerPreviewUpdatePrompt({ onApply }: { onApply: () => void }) {
  return (
    <div className="preview-update-prompt" role="status">
      <span>Ready to publish</span>
      <button className="button icon-only dark" type="button" aria-label="Update displayed overlay" title="Update displayed overlay" onClick={onApply}>
        <Check size={16} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function SoccerControls({
  state,
  media,
  teams,
  commitState
}: {
  state: SoccerState;
  media: MediaItem[];
  teams: TeamLibraryEntry[];
  commitState: (state: PresetState, fields?: SoccerTextAnimationField[]) => void;
}) {
  function updateTeam(side: "home" | "away", patch: Partial<SoccerState["home"]>) {
    const next = { ...state, [side]: mergeTeamPatch(state[side], patch) };
    commitState(next, soccerTeamTextFields(side, next));
  }
  return (
    <div className="match-control-stack">
      <SoccerLiveSetupPanel state={state} teams={teams} commitMatchState={(next, fields) => commitState(next, fields)} />
      <SoccerMatchupTextPanel state={state} commitMatchState={(next, fields) => commitState(next, fields)} />
      <label className="field">
        <span>Scheduled</span>
        <input
          type="datetime-local"
          value={dateTimeLocalValue(state.scheduledAt)}
          onChange={(event) => {
            const date = new Date(event.target.value);
            if (!Number.isNaN(date.getTime())) commitState({ ...state, scheduledAt: date.toISOString() });
          }}
        />
      </label>
      {(["home", "away"] as const).map((side) => (
        <details className="advanced-section" key={side}>
          <summary>
            {side === "home" ? "Home" : "Away"} team details <span className="muted">{state[side].fullName}</span>
          </summary>
          <TeamFields team={state[side]} media={media} onChange={(patch) => updateTeam(side, patch)} />
        </details>
      ))}
    </div>
  );
}

function SoccerBottomControlPanel({
  state,
  serverTimeMs,
  media,
  teams,
  activeTab,
  tabButtons,
  updateClock,
  updatePackage,
  updateMatchPackage,
  previewSurface,
  setPreviewSurface,
  commitMatchState,
  runAction
}: {
  state: SoccerState;
  serverTimeMs?: number;
  media: MediaItem[];
  teams: TeamLibraryEntry[];
  activeTab: string;
  tabButtons: React.ReactNode;
  updateClock: (patch: Partial<SoccerState["clock"]>) => void;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  updateMatchPackage: (patch: Partial<SoccerState["soccerPackage"]>, changedFields?: SoccerTextAnimationField[]) => void;
  previewSurface: SoccerState["soccerPackage"]["surface"];
  setPreviewSurface: (surface: SoccerState["soccerPackage"]["surface"]) => void;
  commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <div className="panel soccer-bottom-control-panel">
      <div className="bottom-control-tabs">{tabButtons}</div>
      {activeTab === "match" ? (
        <SoccerControls state={state} media={media} teams={teams} commitState={(next, fields = []) => commitMatchState(next as SoccerState, fields)} />
      ) : null}
      {activeTab === "setup" ? (
        <SoccerPackageSetupPanel state={state} updatePackage={updatePackage} previewSurface={previewSurface} setPreviewSurface={setPreviewSurface} />
      ) : null}
      {activeTab === "live" ? (
        <div className="live-control-stack">
          <SoccerScoreClockPanel state={state} serverTimeMs={serverTimeMs} updateClock={updateClock} runAction={runAction} />
          <SoccerGraphicFields
            state={state}
            serverTimeMs={serverTimeMs}
            updatePackage={updatePackage}
            updateTextPackage={updateMatchPackage}
            runAction={runAction}
          />
          <SoccerOperationsPanel state={state} serverTimeMs={serverTimeMs} runAction={runAction} />
        </div>
      ) : null}
    </div>
  );
}

function SoccerLiveSetupPanel({
  state,
  teams,
  commitMatchState
}: {
  state: SoccerState;
  teams: TeamLibraryEntry[];
  commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void;
}) {
  const homeMatch = findSavedTeamMatch(state.home, teams);
  const awayMatch = findSavedTeamMatch(state.away, teams);

  function applySavedTeam(side: "home" | "away", teamId: string) {
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) return;
    commitMatchState({ ...state, [side]: teamLibraryToSoccerTeam(team) } as SoccerState, soccerTeamTextFields(side, state));
  }

  function swapTeams() {
    commitMatchState({ ...state, home: state.away, away: state.home }, soccerTeamTextFields("home", state).concat(soccerTeamTextFields("away", state)));
  }

  return (
    <section className="control-section live-setup-panel">
      <div className="panel-heading">
        <h2>Match setup</h2>
        <button className="button" type="button" onClick={swapTeams}>
          Swap teams
        </button>
      </div>
      <div className="two-col">
        <label className="field">
          <span>Home team</span>
          <select value={homeMatch?.id ?? ""} onChange={(event) => applySavedTeam("home", event.target.value)}>
            <option value="">{teams.length ? "Select saved team" : "No saved teams"}</option>
            {teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Away team</span>
          <select value={awayMatch?.id ?? ""} onChange={(event) => applySavedTeam("away", event.target.value)}>
            <option value="">{teams.length ? "Select saved team" : "No saved teams"}</option>
            {teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

const soccerPackageColorFields: Record<SoccerOverlayPackage, Array<{ key: string; label: string }>> = {
  classic: [
    { key: "bg", label: "Background" },
    { key: "soft", label: "Soft fill" },
    { key: "ink", label: "Ink" },
    { key: "muted", label: "Muted text" },
    { key: "faint", label: "Faint rule" },
    { key: "red", label: "Accent red" },
    { key: "rule", label: "Rule" },
    { key: "panelGray", label: "Panel gray" }
  ],
  rounded: [
    { key: "ink", label: "Ink" },
    { key: "muted", label: "Muted text" },
    { key: "line", label: "Line" },
    { key: "gold", label: "Gold" },
    { key: "maroon", label: "Maroon" },
    { key: "wine", label: "Wine" },
    { key: "ivory", label: "Ivory" },
    { key: "sky", label: "Sky" },
    { key: "blue", label: "Blue" },
    { key: "red", label: "Red" }
  ]
};

function SoccerPackageSetupPanel({
  state,
  updatePackage,
  previewSurface,
  setPreviewSurface
}: {
  state: SoccerState;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  previewSurface: SoccerState["soccerPackage"]["surface"];
  setPreviewSurface: (surface: SoccerState["soccerPackage"]["surface"]) => void;
}) {
  const packageName = state.soccerPackage.overlayPackage;
  const activeColors = state.soccerPackage.colorBanks[packageName];

  function updateColor(key: string, value: string) {
    updatePackage({
      colorBanks: {
        ...state.soccerPackage.colorBanks,
        [packageName]: {
          ...activeColors,
          [key]: value
        }
      }
    });
  }

  return (
    <div className="setup-control-stack">
      <section className="control-section">
        <h2>Design</h2>
        <div className="form-grid">
          <label className="field">
            <span>Package</span>
            <select value={packageName} onChange={(event) => updatePackage({ overlayPackage: event.target.value as SoccerOverlayPackage })}>
              <option value="classic">Classic</option>
              <option value="rounded">Rounded</option>
            </select>
          </label>
          <div className="two-col">
            <label className="field">
              <span>Preview background</span>
              <select value={previewSurface} onChange={(event) => setPreviewSurface(event.target.value as SoccerState["soccerPackage"]["surface"])}>
                <option value="pitch">Pitch</option>
                <option value="checker">Checker</option>
                <option value="studio">Studio</option>
              </select>
            </label>
            <label className="control-row">
              <input
                type="checkbox"
                checked={state.soccerPackage.packageBackground}
                onChange={(event) => updatePackage({ packageBackground: event.target.checked })}
              />
              Package background
            </label>
          </div>
          <label className="field">
            <span>Background opacity</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(state.soccerPackage.packageBackgroundOpacity * 100)}
              onChange={(event) => updatePackage({ packageBackgroundOpacity: Number(event.target.value) / 100 })}
            />
          </label>
        </div>
      </section>
      <section className="control-section">
        <h2>Scorebug</h2>
        <div className="two-col">
          <label className="field">
            <span>Layout</span>
            <select value={state.soccerPackage.scorebugLayout} onChange={(e) => updatePackage({ scorebugLayout: e.target.value as "horizontal" | "vertical" })}>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
            </select>
          </label>
          <label className="field">
            <span>Width</span>
            <input
              type="range"
              min="44"
              max="82"
              value={state.soccerPackage.scorebugWidth}
              onChange={(e) => updatePackage({ scorebugWidth: Number(e.target.value) })}
            />
          </label>
        </div>
      </section>
      <section className="control-section">
        <h2>Colors</h2>
        <div className="package-color-grid">
          {soccerPackageColorFields[packageName].map((field) => (
            <label key={field.key} className="field color-swatch-field package-color-field">
              <span>{field.label}</span>
              <input
                type="color"
                value={activeColors[field.key]}
                onInput={(event) => updateColor(field.key, event.currentTarget.value)}
                onChange={(event) => updateColor(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

function SoccerMatchupTextPanel({
  state,
  commitMatchState
}: {
  state: SoccerState;
  commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void;
}) {
  function update(patch: Partial<Pick<SoccerState, "gameTitle" | "productionName">>, changedFields: SoccerTextAnimationField[]) {
    commitMatchState({ ...state, ...patch }, changedFields);
  }

  return (
    <section className="control-section">
      <h2>Matchup text</h2>
      <div className="form-grid">
        <label className="field">
          <span>Title</span>
          <input value={state.gameTitle} onChange={(event) => update({ gameTitle: event.target.value }, ["event-title"])} />
        </label>
        <label className="field">
          <span>Subtitle</span>
          <input value={state.productionName} onChange={(event) => update({ productionName: event.target.value }, ["production-name"])} />
        </label>
      </div>
    </section>
  );
}

function SoccerGraphicFields({
  state,
  serverTimeMs,
  updatePackage,
  updateTextPackage,
  runAction
}: {
  updateTextPackage: (patch: Partial<SoccerState["soccerPackage"]>, fields?: SoccerTextAnimationField[]) => void;
  state: SoccerState;
  serverTimeMs?: number;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const selected = state.soccerPackage.selectedOverlay;
  const pack = state.soccerPackage;
  if (selected === "countdown-timer")
    return <SoccerCountdownPanel state={state} serverTimeMs={serverTimeMs} updatePackage={updatePackage} runAction={runAction} />;
  if (selected === "lineup-panel") {
    const count = Math.max(1, Math.ceil(state[pack.lineupTeam].roster.length / 6));
    const page = Math.min(count - 1, pack.lineupPage);
    return (
      <section className="control-section">
        <h2>Lineup</h2>
        <label className="field">
          <span>Lineup team</span>
          <select value={pack.lineupTeam} onChange={(e) => updatePackage({ lineupTeam: e.target.value as "home" | "away", lineupPage: 0 })}>
            <option value="home">{state.home.fullName}</option>
            <option value="away">{state.away.fullName}</option>
          </select>
        </label>
        <div className="control-row">
          <button className="button" disabled={page === 0} onClick={() => updatePackage({ lineupPage: page - 1 })}>
            Previous players
          </button>
          <span role="status">
            {page + 1} / {count}
          </span>
          <button className="button" disabled={page >= count - 1} onClick={() => updatePackage({ lineupPage: page + 1 })}>
            Next players
          </button>
        </div>
      </section>
    );
  }
  if (selected === "lower-result")
    return (
      <section className="control-section">
        <h2>Score matchup</h2>
        <label className="field">
          <span>Result</span>
          <select value={pack.lowerResultState} onChange={(e) => updatePackage({ lowerResultState: e.target.value as "HALF" | "FINAL" })}>
            <option value="HALF">Halftime</option>
            <option value="FINAL">Final</option>
          </select>
        </label>
      </section>
    );
  if (selected === "one-line-text" || selected === "two-line-text")
    return (
      <section className="control-section">
        <h2>{selected === "one-line-text" ? "One-line text" : "Two-line text"}</h2>
        <div className="form-grid">
          {selected === "one-line-text" ? (
            <>
              <label className="field">
                <span>Text</span>
                <input maxLength={500} value={pack.oneLineText} onChange={(e) => updateTextPackage({ oneLineText: e.target.value }, ["one-line"])} />
              </label>
              <PositionSelect value={pack.oneLinePosition} onChange={(oneLinePosition) => updatePackage({ oneLinePosition })} />
            </>
          ) : (
            <>
              <label className="field">
                <span>Top line</span>
                <input maxLength={500} value={pack.twoLineTextA} onChange={(e) => updateTextPackage({ twoLineTextA: e.target.value }, ["two-line-a"])} />
              </label>
              <label className="field">
                <span>Bottom line</span>
                <input maxLength={500} value={pack.twoLineTextB} onChange={(e) => updateTextPackage({ twoLineTextB: e.target.value }, ["two-line-b"])} />
              </label>
              <PositionSelect value={pack.twoLinePosition} onChange={(twoLinePosition) => updatePackage({ twoLinePosition })} />
            </>
          )}
        </div>
      </section>
    );
  return null;
}

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
function useControlTime(serverTimeMs: number | undefined, deadline: number | null) {
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

function SoccerOperationsPanel({
  state,
  serverTimeMs,
  runAction
}: {
  state: SoccerState;
  serverTimeMs?: number;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [team, setTeam] = useState<"home" | "away">("home");
  const deadline = Math.min(...state.activeGraphics.map((graphic) => graphic.expiresAtMs ?? Infinity));
  const now = useControlTime(serverTimeMs, deadline);
  const active = state.activeGraphics.filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > now);
  const graphics = [
    ["Goal", "trigger-goal", "goal"],
    ["Yellow card", "trigger-yellow-card", "yellow-card"],
    ["Red card", "trigger-red-card", "red-card"],
    ["Substitution", "trigger-substitution", "substitution"],
    ["Lineup", "trigger-lineups", "lineups"],
    ["Sponsor", "trigger-sponsor", "sponsor"],
    ["Lower third", "trigger-lower-third", "lower-third"],
    ["Halftime", "trigger-halftime", "halftime"],
    ["Full time", "trigger-full-time", "fullscreen"]
  ];
  return (
    <section className="control-section soccer-operations-panel">
      <h2>Quick graphics</h2>
      <label className="field">
        <span>Team</span>
        <select value={team} onChange={(e) => setTeam(e.target.value as "home" | "away")}>
          <option value="home">{state.home.fullName}</option>
          <option value="away">{state.away.fullName}</option>
        </select>
      </label>
      <div className="temporary-graphic-actions">
        {graphics.map(([label, action, kind]) => {
          const showing = active.some((graphic) => graphic.kind === kind);
          return (
            <button
              className={`button ${showing ? "on-air" : ""}`}
              type="button"
              key={action}
              aria-pressed={showing}
              onClick={() =>
                void runAction(action, { team, ...(title.trim() ? { title: title.trim() } : {}), ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}) })
              }
            >
              {showing ? `Hide ${label.toLowerCase()}` : label}
            </button>
          );
        })}
      </div>
      <details className="advanced-section">
        <summary>Custom text</summary>
        <div className="two-col">
          <label className="field">
            <span>Graphic title</span>
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Subtitle / player</span>
            <input value={subtitle} maxLength={500} onChange={(e) => setSubtitle(e.target.value)} />
          </label>
        </div>
      </details>
    </section>
  );
}

const labOverlayOrder: SoccerLabOverlay[] = [
  "full-matchup",
  "lower-matchup",
  "lower-result",
  "lineup-panel",
  "scorebug",
  "countdown-timer",
  "one-line-text",
  "two-line-text"
];

const labOverlayLabels: Record<SoccerLabOverlay, string> = {
  "full-matchup": "Full page matchup",
  "lower-matchup": "Lower matchup",
  "lower-result": "Lower score matchup",
  "lineup-panel": "Lineup panel",
  scorebug: "Scorebug",
  "countdown-timer": "Countdown timer",
  "one-line-text": "1-line text bug",
  "two-line-text": "2-line text bug"
};

function SoccerLabOverlayControls({
  state,
  updatePackage,
  runAction,
  onSelect
}: {
  onSelect: (overlay: SoccerLabOverlay) => void;
  state: SoccerState;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const selected = state.soccerPackage.selectedOverlay;

  function takeOverlay(overlay: SoccerLabOverlay) {
    onSelect(overlay);
    if (state.soccerPackage.activeOverlay === overlay) {
      void runAction("hide-overlay", { overlay });
      return;
    }
    void runAction("show-overlay", { overlay });
  }

  return (
    <div className="lab-overlay-list">
      <div className="panel-heading">
        <div>
          <h2>Overlays</h2>
        </div>
      </div>
      <div className="compact-overlay-picker">
        <label className="field">
          <span>Graphic</span>
          <select
            value={selected}
            onChange={(event) => {
              const overlay = event.target.value as SoccerLabOverlay;
              updatePackage({ selectedOverlay: overlay });
              onSelect(overlay);
            }}
          >
            {labOverlayOrder.map((overlay) => (
              <option key={overlay} value={overlay}>
                {labOverlayLabels[overlay]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`button ${state.soccerPackage.activeOverlay === selected ? "on-air" : "primary"}`}
          onClick={() => takeOverlay(selected)}
        >
          {state.soccerPackage.activeOverlay === selected ? "Hide graphic" : "Show graphic"}
        </button>
      </div>
      <div className="overlay-card-grid">
        {labOverlayOrder.map((overlay) => (
          <div
            key={overlay}
            className={`overlay-control-card ${selected === overlay ? "selected" : ""} ${state.soccerPackage.activeOverlay === overlay ? "active" : ""}`}
          >
            <button
              className="overlay-card-select"
              type="button"
              aria-pressed={selected === overlay}
              onClick={() => {
                updatePackage({ selectedOverlay: overlay });
                onSelect(overlay);
              }}
            >
              <strong>{labOverlayLabels[overlay]}</strong>
            </button>
            <button
              className={`overlay-card-action ${state.soccerPackage.activeOverlay === overlay ? "is-active" : ""}`}
              type="button"
              aria-label={state.soccerPackage.activeOverlay === overlay ? `Stop ${labOverlayLabels[overlay]}` : `Play ${labOverlayLabels[overlay]}`}
              title={state.soccerPackage.activeOverlay === overlay ? "Stop overlay" : "Play overlay"}
              onClick={() => takeOverlay(overlay)}
            >
              {state.soccerPackage.activeOverlay === overlay ? (
                <Square size={12} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={12} fill="currentColor" strokeWidth={0} />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const positionOptions: PositionPreset[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

function PositionSelect({ value, onChange }: { value: PositionPreset; onChange: (value: PositionPreset) => void }) {
  return (
    <label className="field">
      <span>Position</span>
      <select value={value} onChange={(event) => onChange(event.target.value as PositionPreset)}>
        {positionOptions.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function TeamLogo({ team }: { team: SoccerState["home"] }) {
  return team.logoUrl ? (
    <img className="team-library-logo" src={mediaApi.mediaUrl(team.logoUrl)} alt="" />
  ) : (
    <span className="team-library-logo fallback">{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
  );
}

export function TeamFields({
  team,
  media,
  onChange
}: {
  team: SoccerState["home"];
  media: MediaItem[];
  onChange: (patch: Partial<SoccerState["home"]>) => void;
}) {
  const record = team.record || { wins: 0, losses: 0, draws: 0 };
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const latestTeamRef = useRef(team);
  const colorsEditedRef = useRef(false);
  const mountedRef = useRef(true);
  const uploadGenerationRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const teamIdentity = (team as Partial<TeamLibraryEntry>).id ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadGenerationRef.current += 1;
      uploadAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (latestTeamRef.current !== team && uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
      uploadGenerationRef.current += 1;
      setUploadingLogo(false);
    }
    latestTeamRef.current = team;
  }, [team]);

  useEffect(() => {
    colorsEditedRef.current = false;
  }, [teamIdentity]);

  async function uploadLogo(files: FileList | File[]) {
    const file = Array.from(files)[0];
    if (!file) return;
    const uploadGeneration = uploadGenerationRef.current + 1;
    uploadGenerationRef.current = uploadGeneration;
    const uploadTeam = latestTeamRef.current;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadingLogo(true);
    setLogoError(null);
    try {
      const shouldExtractColors = !colorsEditedRef.current && shouldAutofillTeamColors(uploadTeam);
      const [response, extractedColors] = await Promise.all([
        mediaApi.upload(file, controller.signal),
        shouldExtractColors ? extractLogoColors(file).catch(() => null) : Promise.resolve(null)
      ]);
      const patch: Partial<SoccerState["home"]> = { logoMediaId: response.media.id, logoUrl: response.media.url };
      if (!mountedRef.current || uploadGenerationRef.current !== uploadGeneration || latestTeamRef.current !== uploadTeam) return;
      if (extractedColors && !colorsEditedRef.current && shouldAutofillTeamColors(uploadTeam)) {
        patch.primaryColor = extractedColors.primaryColor;
        patch.secondaryColor = extractedColors.secondaryColor;
      }
      onChange(patch);
      announceMediaUpload(response.media);
    } catch (err) {
      if (mountedRef.current && uploadGenerationRef.current === uploadGeneration && !controller.signal.aborted) {
        setLogoError(err instanceof Error ? err.message : "Logo upload failed");
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (mountedRef.current && uploadGenerationRef.current === uploadGeneration) setUploadingLogo(false);
    }
  }

  return (
    <div className="form-grid">
      <div className="two-col">
        <label className="field">
          <span>Team name</span>
          <input value={team.fullName} onChange={(e) => onChange({ fullName: e.target.value })} />
        </label>
        <label className="field">
          <span>Abbreviation</span>
          <input
            value={team.abbreviation}
            onChange={(e) => onChange({ abbreviation: e.target.value.toUpperCase().slice(0, 5), shortName: e.target.value.toUpperCase().slice(0, 5) })}
          />
        </label>
      </div>
      <div className="record-color-row">
        <RecordInput key={teamIdentity ?? team.fullName} value={record} onCommit={(record) => onChange({ record })} />
        <div className="color-swatch-group" aria-label="Team colors">
          <label className="field color-swatch-field">
            <span>Primary</span>
            <input
              type="color"
              value={team.primaryColor}
              onChange={(e) => {
                colorsEditedRef.current = true;
                onChange({ primaryColor: e.target.value });
              }}
            />
          </label>
          <label className="field color-swatch-field">
            <span>Secondary</span>
            <input
              type="color"
              value={team.secondaryColor}
              onChange={(e) => {
                colorsEditedRef.current = true;
                onChange({ secondaryColor: e.target.value });
              }}
            />
          </label>
        </div>
      </div>
      <div className="field">
        <span>Logo</span>
        <label
          className="logo-upload-target"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void uploadLogo(event.dataTransfer.files);
          }}
        >
          {team.logoUrl ? <img src={mediaApi.mediaUrl(team.logoUrl)} alt="" /> : <Upload size={20} />}
          <strong>{uploadingLogo ? "Uploading..." : "Upload logo"}</strong>
          <small>{team.logoUrl ? "Drop or click to replace" : "Drop image here or click"}</small>
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="visually-hidden-file-input"
            aria-label="Upload team logo"
            onChange={(event) => {
              const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
              event.currentTarget.value = "";
              if (files.length > 0) void uploadLogo(files);
            }}
          />
        </label>
        {logoError ? (
          <p className="field-error" role="alert">
            {logoError}
          </p>
        ) : null}
        <MediaPicker
          label="Choose existing logo from media library"
          selectedId={team.logoMediaId}
          initialItems={media}
          onSelect={(item) => onChange({ logoMediaId: item?.id ?? "", logoUrl: item?.url ?? "" })}
        />
      </div>
      {team.logoUrl ? (
        <details className="image-crop-controls advanced-section">
          <summary>Crop logo</summary>
          <div className="panel-heading compact">
            <h3>Image crop</h3>
          </div>
          <div className="crop-preview" style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}>
            {team.logoUrl ? (
              <img
                src={mediaApi.mediaUrl(team.logoUrl)}
                alt=""
                style={{
                  transform: `translate(${team.imageCrop.x}px, ${team.imageCrop.y}px) scale(${team.imageCrop.zoom})`
                }}
              />
            ) : (
              <span>{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
            )}
          </div>
          <div className="three-col">
            <NumberField label="X" value={team.imageCrop.x} onChange={(value) => onChange({ imageCrop: { ...team.imageCrop, x: value } })} />
            <NumberField label="Y" value={team.imageCrop.y} onChange={(value) => onChange({ imageCrop: { ...team.imageCrop, y: value } })} />
            <label className="field">
              <span>Zoom</span>
              <input
                type="number"
                min="0.25"
                step="0.05"
                value={team.imageCrop.zoom}
                onChange={(event) => onChange({ imageCrop: { ...team.imageCrop, zoom: Math.max(0.25, Number(event.target.value)) } })}
              />
            </label>
          </div>
        </details>
      ) : null}

      <label className="field">
        <span>Roster</span>
        <textarea className="roster-textarea" value={team.rosterText} onChange={(e) => onChange({ rosterText: e.target.value })} placeholder="10 Max Grenham" />
      </label>
      <label className="field">
        <span>Coach</span>
        <input value={team.coach} onChange={(e) => onChange({ coach: e.target.value })} />
      </label>
    </div>
  );
}

function StylePanel({ state, commitState }: { state: SoccerState | ChurchState; commitState: (state: PresetState) => void }) {
  const variants: StyleVariant[] = ["clean", "glass", "stripe", "broadcast", "neon"];
  return (
    <div className="panel">
      <h2>Global style</h2>
      <div className="form-grid">
        <label className="field">
          <span>Font</span>
          <select value={state.style.font} onChange={(e) => commitState({ ...state, style: { ...state.style, font: e.target.value } })}>
            {!["Arial", "Verdana", "Georgia", "Courier New"].includes(state.style.font) ? <option value={state.style.font}>{state.style.font}</option> : null}
            {["Arial", "Verdana", "Georgia", "Courier New"].map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Accent</span>
          <input
            type="color"
            value={state.style.accentColor}
            onChange={(e) => commitState({ ...state, style: { ...state.style, accentColor: e.target.value } })}
          />
        </label>
        <label className="field">
          <span>Theme</span>
          <select value={state.style.theme} onChange={(e) => commitState({ ...state, style: { ...state.style, theme: e.target.value as StyleVariant } })}>
            {variants.map((variant) => (
              <option key={variant} value={variant}>
                {variant}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Animation</span>
          <select
            value={state.style.animation}
            onChange={(e) => commitState({ ...state, style: { ...state.style, animation: e.target.value as SoccerState["style"]["animation"] } })}
          >
            <option value="subtle">subtle</option>
            <option value="standard">standard</option>
            <option value="flashy">flashy</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function ChurchControls({
  state,
  serverTimeMs,
  media,
  tab,
  commitState,
  runAction,
  outputUrl,
  disabled
}: {
  outputUrl?: string;
  disabled?: boolean;
  state: ChurchState;
  serverTimeMs?: number;
  media: MediaItem[];
  tab: string;
  commitState: (state: PresetState) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const onAir = churchOnAirSlide(state);
  const selected = state.slides.find((slide) => slide.id === state.selectedSlideId);
  const [countdownSeconds, setCountdownSeconds] = useState(5 * 60);
  const [countdownValid, setCountdownValid] = useState(true);
  const timeAnchor = useMemo(() => ({ server: serverTimeMs ?? Date.now(), received: performance.now() }), [serverTimeMs]);
  const [, refreshExpiry] = useState(0);
  const now = timeAnchor.server + Math.max(0, performance.now() - timeAnchor.received);
  const activeGraphics = state.activeGraphics.filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > now);
  const nextExpiry = Math.min(...activeGraphics.map((graphic) => graphic.expiresAtMs ?? Infinity));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const remaining = nextExpiry - timeAnchor.server - Math.max(0, performance.now() - timeAnchor.received);
    const timer = window.setTimeout(() => refreshExpiry((value) => value + 1), Math.min(2_147_483_647, Math.max(1, Math.ceil(remaining))));
    return () => window.clearTimeout(timer);
  }, [nextExpiry, timeAnchor]);
  const lowerThirdActive = activeGraphics.some((graphic) => graphic.kind === "church-lower-third" || graphic.kind === "lower-third");
  const countdownActive = activeGraphics.some((graphic) => graphic.kind === "countdown");

  function setElementVisible(element: keyof ChurchState["elements"], visible: boolean) {
    commitState({
      ...state,
      onAirSlide: onAir ? structuredClone(onAir) : null,
      elements: { ...state.elements, [element]: { ...state.elements[element], visible } }
    });
  }
  if (tab === "style") return <StylePanel state={state} commitState={commitState} />;
  return (
    <ChurchWorkspace
      state={state}
      media={media}
      commitState={commitState}
      outputUrl={outputUrl}
      disabled={disabled}
      cues={
        <div className="form-grid">
          <label className="control-row">
            <input type="checkbox" checked={state.elements.lowerThird.visible} onChange={(event) => setElementVisible("lowerThird", event.target.checked)} />
            <span>Enable lower third</span>
          </label>
          <button
            className="button"
            type="button"
            disabled={!selected || !state.elements.lowerThird.visible}
            onClick={() => void runAction("trigger-lower-third", { title: selected?.title, subtitle: selected?.text })}
          >
            {lowerThirdActive ? "Hide lower third" : "Show selected lower third"}
          </button>
          <label className="control-row">
            <input type="checkbox" checked={state.elements.countdown.visible} onChange={(event) => setElementVisible("countdown", event.target.checked)} />
            <span>Enable countdown</span>
          </label>
          <label className="field">
            <span>Countdown length</span>
            <SyncedTimeInput
              seconds={countdownSeconds}
              minSeconds={1}
              maxSeconds={3_600}
              describedBy="church-countdown-guidance"
              onValidityChange={setCountdownValid}
              onCommit={setCountdownSeconds}
            />
          </label>
          <small id="church-countdown-guidance">1 second to 60 minutes. Use M:SS.</small>
          <button
            className="button"
            type="button"
            disabled={!state.elements.countdown.visible || !countdownValid}
            onClick={() => void runAction("trigger-countdown", { title: "Service begins in", durationSeconds: countdownSeconds })}
          >
            {countdownActive ? "Stop countdown" : "Start countdown"}
          </button>
        </div>
      }
    />
  );
}

function ElementInspector({ state, element, commitState }: { state: PresetState; element: OverlayElementConfig; commitState: (state: PresetState) => void }) {
  function updateElement(patch: Partial<OverlayElementConfig>) {
    const copy = structuredClone(state) as PresetState;
    const candidate = getElementById(copy, element.id);
    if (candidate) Object.assign(candidate, patch);
    commitState(copy);
  }

  function updatePlacement(patch: Partial<OverlayElementConfig["placement"]>) {
    updateElement({ placement: { ...element.placement, ...patch } });
  }

  return (
    <div className="panel">
      <h2>Lower third layout</h2>
      <div className="form-grid">
        <label className="field">
          <span>Position preset</span>
          <select
            value={element.placement.preset}
            onChange={(e) => updatePlacement(placementForPreset(e.target.value as PositionPreset, element.placement.width, element.placement.height))}
          >
            {["top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right", "custom"].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="two-col">
          <NumberField label="X" value={element.placement.x} onChange={(value) => updatePlacement({ x: value, preset: "custom" })} />
          <NumberField label="Y" value={element.placement.y} onChange={(value) => updatePlacement({ y: value, preset: "custom" })} />
          <NumberField label="Width" value={element.placement.width} onChange={(value) => updatePlacement({ width: value })} />
          <NumberField label="Height" value={element.placement.height} onChange={(value) => updatePlacement({ height: value })} />
        </div>
        <label className="field">
          <span>Scale</span>
          <input type="number" step="0.05" value={element.placement.scale} onChange={(e) => updatePlacement({ scale: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Variant</span>
          <select value={element.variant} onChange={(e) => updateElement({ variant: e.target.value as StyleVariant })}>
            {["clean", "glass", "stripe", "broadcast", "neon"].map((variant) => (
              <option key={variant} value={variant}>
                {variant}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

interface LogoColorSample {
  r: number;
  g: number;
  b: number;
  saturation: number;
  lightness: number;
}

interface LogoColorCluster extends LogoColorSample {
  count: number;
  score: number;
}

function shouldAutofillTeamColors(team: Pick<SoccerState["home"], "primaryColor" | "secondaryColor">): boolean {
  return DEFAULT_TEAM_COLOR_PAIRS.some((pair) => {
    return sameHexColor(team.primaryColor, pair.primaryColor) && sameHexColor(team.secondaryColor, pair.secondaryColor);
  });
}

async function extractLogoColors(file: File): Promise<{ primaryColor: string; secondaryColor: string } | null> {
  if (!file.type.startsWith("image/")) return null;
  const image = await loadImageFromFile(file);
  const maxSize = 128;
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const samples: LogoColorSample[] = [];

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 80) continue;
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const { saturation, lightness } = rgbToHsl(r, g, b);
    if (lightness > 0.98 && saturation < 0.08) continue;
    samples.push({ r, g, b, saturation, lightness });
  }

  if (!samples.length) return null;
  const chromaticSamples = samples.filter((sample) => sample.saturation >= 0.18 && sample.lightness > 0.1 && sample.lightness < 0.94);
  const sourceSamples = chromaticSamples.length >= Math.max(12, samples.length * 0.01) ? chromaticSamples : samples;
  const clusters = clusterLogoColors(sourceSamples);
  const primary = clusters[0];
  if (!primary) return null;
  const secondary = clusters.find((cluster) => colorDistance(primary, cluster) >= 54) ?? clusters[1] ?? deriveSecondaryColor(primary);
  return {
    primaryColor: rgbToHex(primary),
    secondaryColor: rgbToHex(secondary)
  };
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read logo image"));
    };
    image.src = url;
  });
}

function clusterLogoColors(samples: LogoColorSample[]): LogoColorCluster[] {
  const buckets = new Map<string, { r: number; g: number; b: number; count: number; score: number; saturation: number; lightness: number }>();
  for (const sample of samples) {
    const key = [quantizeColor(sample.r), quantizeColor(sample.g), quantizeColor(sample.b)].join("-");
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0, score: 0, saturation: 0, lightness: 0 };
    bucket.r += sample.r;
    bucket.g += sample.g;
    bucket.b += sample.b;
    bucket.count += 1;
    bucket.saturation += sample.saturation;
    bucket.lightness += sample.lightness;
    bucket.score += 0.7 + sample.saturation;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      count: bucket.count,
      saturation: bucket.saturation / bucket.count,
      lightness: bucket.lightness / bucket.count,
      score: bucket.score
    }))
    .sort((a, b) => b.score - a.score);
}

function deriveSecondaryColor(color: LogoColorSample): LogoColorSample {
  const { h, saturation, lightness } = rgbToHsl(color.r, color.g, color.b);
  const derivedLightness = lightness > 0.54 ? Math.max(0.18, lightness - 0.34) : Math.min(0.88, lightness + 0.34);
  return hslToRgb(h, Math.max(0.2, saturation * 0.75), derivedLightness);
}

function quantizeColor(value: number): number {
  return Math.round(value / 24) * 24;
}

function sameHexColor(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function colorDistance(left: LogoColorSample, right: LogoColorSample): number {
  const redMean = (left.r + right.r) / 2;
  const red = left.r - right.r;
  const green = left.g - right.g;
  const blue = left.b - right.b;
  return Math.sqrt((2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue);
}

function rgbToHex(color: Pick<LogoColorSample, "r" | "g" | "b">): string {
  return `#${[color.r, color.g, color.b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; saturation: number; lightness: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === red) h = (green - blue) / delta + (green < blue ? 6 : 0);
  if (max === green) h = (blue - red) / delta + 2;
  if (max === blue) h = (red - green) / delta + 4;
  return { h: h / 6, saturation, lightness };
}

function hslToRgb(h: number, saturation: number, lightness: number): LogoColorSample {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { r: value, g: value, b: value, saturation, lightness };
  }
  const hueToRgb = (p: number, q: number, t: number) => {
    let hue = t;
    if (hue < 0) hue += 1;
    if (hue > 1) hue -= 1;
    if (hue < 1 / 6) return p + (q - p) * 6 * hue;
    if (hue < 1 / 2) return q;
    if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
    return p;
  };
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    saturation,
    lightness
  };
}

function mergeTeamPatch<T extends SoccerState["home"]>(team: T, patch: Partial<SoccerState["home"]>): T {
  const rosterText = patch.rosterText ?? team.rosterText;
  return {
    ...team,
    ...patch,
    roster: patch.rosterText !== undefined ? parseRoster(rosterText) : (patch.roster ?? team.roster),
    record: patch.record ? { ...(team.record || { wins: 0, losses: 0, draws: 0 }), ...patch.record } : team.record
  };
}

function makeAbbreviation(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 3) || "TEAM"
  );
}

function findSavedTeamMatch(team: SoccerState["home"], teams: TeamLibraryEntry[]): TeamLibraryEntry | undefined {
  return teams.find((candidate) => candidate.fullName === team.fullName || candidate.abbreviation === team.abbreviation);
}

function dateTimeLocalValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function titleCaseFirst(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

function saveStatusLabel(status: "idle" | "saving" | "saved" | "error", updatedAt: string): string {
  if (status === "saving") return "Autosaving...";
  if (status === "saved") return "Saved";
  if (status === "error") return "Autosave failed";
  return `Updated ${new Date(updatedAt).toLocaleDateString()}`;
}

function formatRecord(record?: SoccerState["home"]["record"]): string {
  const value = record || { wins: 0, losses: 0, draws: 0 };
  return `${value.wins}-${value.losses}-${value.draws}`;
}

function soccerTeamTextFields(side: "home" | "away", state: SoccerState): SoccerTextAnimationField[] {
  const fields: SoccerTextAnimationField[] =
    side === "home" ? ["home-name", "home-abbrev", "home-record", "home-logo"] : ["away-name", "away-abbrev", "away-record", "away-logo"];
  if (state.soccerPackage.lineupTeam === side) fields.push("lineup-title", "lineup-logo", "lineup-rows");
  return fields;
}

function soccerTextFieldIsVisible(field: SoccerTextAnimationField, overlay: SoccerLabOverlay | null, state: SoccerState | null): boolean {
  if (!overlay || !state) return false;
  switch (overlay) {
    case "full-matchup":
      return ["event-title", "production-name", "home-name", "away-name", "home-record", "away-record", "home-logo", "away-logo"].includes(field);
    case "lower-matchup":
      return ["event-title", "home-name", "away-name", "home-record", "away-record", "home-logo", "away-logo"].includes(field);
    case "lower-result":
      return ["event-title", "home-abbrev", "away-abbrev", "home-logo", "away-logo"].includes(field);
    case "lineup-panel":
      return ["lineup-title", "lineup-logo", "lineup-rows"].includes(field);
    case "scorebug":
      return ["home-abbrev", "away-abbrev"].includes(field);
    case "one-line-text":
      return field === "one-line";
    case "two-line-text":
      return field === "two-line-a" || field === "two-line-b";
    case "countdown-timer":
      return false;
  }
}

function uniqueSoccerTextFields(fields: SoccerTextAnimationField[]): SoccerTextAnimationField[] {
  return Array.from(new Set(fields));
}

function teamLibraryToSoccerTeam(team: TeamLibraryEntry): SoccerState["home"] {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...soccerTeam } = team;
  return soccerTeam;
}

function demoSoccerState(): SoccerState {
  const state = createDefaultSoccerState("District Championship");
  state.score.home = 2;
  state.score.away = 1;
  state.clock.running = true;
  state.clock.startedAtMs = Date.now() - 34 * 60 * 1000;
  state.clock.baseSeconds = 0;
  return state;
}

function isSoccerState(state: PresetState): state is SoccerState {
  return "score" in state && "clock" in state;
}

function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state;
}

function getPresetRevision(preset: PresetSummary): number | undefined {
  const revision = (preset as PresetSummary & { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}

function requestProgrammaticNavigation(): boolean {
  return window.dispatchEvent(new Event(PROGRAMMATIC_NAVIGATION_EVENT, { cancelable: true }));
}

function allowProgrammaticNavigation(): void {
  window.dispatchEvent(new Event(ALLOW_PROGRAMMATIC_NAVIGATION_EVENT));
}

function useUnsavedNavigationBlocker(hasUnsavedWork: () => boolean, allowNextNavigationRef: React.MutableRefObject<boolean>, message: string) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search && currentLocation.hash === nextLocation.hash) {
      return false;
    }
    if (allowNextNavigationRef.current) {
      allowNextNavigationRef.current = false;
      return false;
    }
    return hasUnsavedWork();
  });

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);
}
