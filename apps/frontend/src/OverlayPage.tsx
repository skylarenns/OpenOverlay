import { useEffect, useLayoutEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { OPENOVERLAY_API_VERSION, OPENOVERLAY_REALTIME_VERSION, type ChurchState, type PresetState, type PresetSummary } from "@openoverlay/shared";
import { ChurchDisplay, ChurchStageScreen } from "./components/ChurchPresentation";
import { OverlayRenderer } from "./components/OverlayRenderer";
import { WS_URL, isPreset, isPresetDeletedEvent, isRealtimeErrorMessage, overlayApi } from "./lib/api";
import { RealtimeRetry } from "./lib/realtimeRetry";

export function OverlayPage({ test }: { test: boolean }) {
  const { overlayId } = useParams();
  const [searchParams] = useSearchParams();
  const [overlay, setOverlay] = useState<PresetSummary | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);
  const client = searchParams.get("client") === "preview" ? "preview" : "overlay";
  const isStage = searchParams.get("display") === "stage";
  const stageKey = isStage ? window.location.hash.slice(1) : "";

  useLayoutEffect(() => {
    document.documentElement.classList.add("overlay-route-root");
    document.body.classList.add("overlay-route-body");
    let theme: "light" | "dark" | null = null;
    try {
      const stored = window.localStorage.getItem("openoverlay:theme");
      if (stored === "light" || stored === "dark") theme = stored;
    } catch {
      // Follow the OS preference if storage is unavailable.
    }
    document.documentElement.dataset.theme = theme ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    return () => {
      document.documentElement.classList.remove("overlay-route-root");
      document.body.classList.remove("overlay-route-body");
    };
  }, []);

  useEffect(() => {
    if (!overlayId) return;
    const requestedOverlayId = overlayId;
    const controller = new AbortController();
    let active = true;
    let deleted = false;
    let socketHasUpdated = false;
    let latestRevision = -1;
    setOverlay(null);
    setError(null);
    setConnection("connecting");

    if (isStage && !/^[A-Za-z0-9_-]{43}$/.test(stageKey)) {
      setError("Stage link is missing or invalid.");
      setConnection("disconnected");
      return () => {
        active = false;
        controller.abort();
      };
    }

    void (isStage ? overlayApi.getStage(requestedOverlayId, stageKey, controller.signal) : overlayApi.get(requestedOverlayId, controller.signal))
      .then((response) => {
        if (!active || deleted || controller.signal.aborted || response.overlay.publicId !== requestedOverlayId) return;
        const responseRevision = getPresetRevision(response.overlay) ?? -1;
        if (socketHasUpdated && responseRevision <= latestRevision) return;
        if (socketHasUpdated && responseRevision === -1) return;
        latestRevision = Math.max(latestRevision, responseRevision);
        setError(null);
        setOverlay(response.overlay);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted || socketHasUpdated) return;
        setError(err instanceof Error ? err.message : "Could not load overlay");
      });
    const socket = io(WS_URL, {
      autoConnect: false,
      transports: ["polling", "websocket"],
      tryAllTransports: true,
      auth: isStage
        ? { role: "stage", overlayId, stageKey, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
        : { role: "overlay", overlayId, client, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION },
      query: isStage
        ? { role: "stage", overlayId, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
        : { role: "overlay", overlayId, client, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
    });
    const retry = new RealtimeRetry(() => socket.connect());
    queueMicrotask(() => {
      if (active && !deleted) socket.connect();
    });
    function enterDeletedState() {
      if (!active || deleted) return;
      deleted = true;
      controller.abort();
      setOverlay(null);
      setError("This overlay was deleted and is no longer available.");
      setConnection("disconnected");
      retry.stop();
      socket.disconnect();
    }
    socket.on("connect", () => {
      if (active) setConnection("connected");
    });
    socket.on("disconnect", (reason) => {
      if (!active || deleted) return;
      if (isStage) setOverlay(null);
      setConnection("disconnected");
      retry.disconnected(reason);
    });
    socket.on("connect_error", () => {
      if (active) setConnection("disconnected");
    });
    socket.on("state:update", (payload: unknown) => {
      if (!active || deleted || !isPreset(payload) || payload.publicId !== requestedOverlayId) return;
      const incomingRevision = getPresetRevision(payload);
      if (incomingRevision === undefined) return;
      if (incomingRevision < latestRevision) return;
      retry.receivedState();
      socketHasUpdated = true;
      latestRevision = incomingRevision;
      setError(null);
      setOverlay(payload);
    });
    socket.on("preset:deleted", (payload: unknown) => {
      if (!active || deleted || !isPresetDeletedEvent(payload) || payload.publicId !== requestedOverlayId) return;
      enterDeletedState();
    });
    socket.on("error:message", (payload: unknown) => {
      if (!active || deleted || !isRealtimeErrorMessage(payload)) return;
      if (payload.error === "Overlay not found") enterDeletedState();
      if (payload.error === "Stage not found") {
        setOverlay(null);
        setError("Stage access was revoked or the link is invalid.");
        retry.stop();
        socket.disconnect();
      }
      if (payload.error === "Incompatible OpenOverlay API or realtime version" || payload.error === "Authentication required") {
        retry.stop();
        setError(payload.error);
      }
    });
    return () => {
      active = false;
      retry.stop();
      controller.abort();
      socket.disconnect();
    };
  }, [client, isStage, overlayId, stageKey]);

  if (test) {
    return (
      <div className="overlay-test-page">
        <div className="page-title">
          <div>
            <h1>Overlay test</h1>
            <p className="muted">
              {overlayId} · {connection}
            </p>
          </div>
          <Link className="button" to={overlay ? `/overlay/${overlay.publicId}` : "#"} target="_blank" rel="noreferrer">
            Open output
          </Link>
        </div>
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="overlay-test-frame">
          {overlay ? <OverlayRenderer type={overlay.type} state={overlay.state} serverTimeMs={overlay.serverTimeMs} safeArea /> : null}
        </div>
      </div>
    );
  }

  if (overlay?.type === "church" && isChurchState(overlay.state) && ["projector", "stage"].includes(searchParams.get("display") ?? "")) {
    const mode = searchParams.get("display") === "stage" ? "stage" : "projector";
    const content =
      mode === "stage" ? (
        <ChurchStageScreen state={overlay.state} serverTimeMs={overlay.serverTimeMs} connected={connection === "connected"} />
      ) : (
        <OverlayRenderer type="church" state={overlay.state} serverTimeMs={overlay.serverTimeMs} />
      );
    return client === "preview" ? (
      <main className="church-display church-display-projector" aria-label="Projector output">
        {content}
      </main>
    ) : (
      <ChurchDisplay mode={mode}>{content}</ChurchDisplay>
    );
  }
  return (
    <div className="overlay-page">
      {overlay ? <OverlayRenderer type={overlay.type} state={overlay.state} serverTimeMs={overlay.serverTimeMs} /> : null}
      {error ? <span style={{ color: "transparent" }}>{error}</span> : null}
    </div>
  );
}

function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state;
}

function getPresetRevision(preset: PresetSummary): number | undefined {
  const revision = (preset as PresetSummary & { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}
