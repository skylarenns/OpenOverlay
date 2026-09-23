import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { OverlayRenderer } from "./OverlayRenderer";

function frameBody(container: HTMLElement) {
  return container.querySelector<HTMLIFrameElement>(".lab-frame")?.contentDocument?.body || null;
}

async function frameText(container: HTMLElement) {
  await waitFor(() => expect(frameBody(container)?.textContent || "").not.toBe(""));
  return frameBody(container)?.textContent || "";
}

describe("OverlayRenderer", () => {
  it.each([100, 700])("cancels a queued entrance when graphics are cleared %i ms into a transition", async (clearAfterMs) => {
    const state = createDefaultSoccerState("Interrupted transition");
    const { container, rerender, unmount } = render(<OverlayRenderer type="soccer" state={state} />);
    await frameText(container);
    await waitFor(() => expect(Boolean(frameBody(container)?.querySelector(".overlay-entering"))).toBe(false), { timeout: 1500 });
    vi.useFakeTimers();
    try {
      // Finish the initial entrance, then start switching to a scorebug.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const next = structuredClone(state);
      next.soccerPackage.activeOverlay = "scorebug";
      rerender(<OverlayRenderer type="soccer" state={next} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(clearAfterMs);
      });
      const cleared = structuredClone(next);
      cleared.soccerPackage.activeOverlay = null;
      rerender(<OverlayRenderer type="soccer" state={cleared} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(Boolean(frameBody(container)?.querySelector(".overlay-scorebug:not(.overlay-exiting)"))).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(Boolean(frameBody(container)?.querySelector(".overlay-entering, .overlay-exiting"))).toBe(false);
      rerender(<OverlayRenderer type="soccer" state={next} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(frameBody(container)?.querySelector('[aria-label="Scorebug"]')).not.toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("uses server time for countdowns even when the capture machine clock is wrong", () => {
    const serverTimeMs = Date.now() - 120_000;
    const state = createDefaultChurchState("Clock skew");
    state.activeGraphics = [
      {
        id: "countdown-skew",
        kind: "countdown",
        title: "Starts in",
        label: "Countdown",
        variant: "broadcast",
        placement: state.elements.countdown.placement,
        startedAtMs: serverTimeMs,
        durationMs: 60_000,
        expiresAtMs: serverTimeMs + 60_000
      }
    ];
    render(<OverlayRenderer type="church" state={state} serverTimeMs={serverTimeMs} />);
    expect(screen.getByLabelText("Starts in: 01:00")).toBeInTheDocument();
  });

  it("can switch overlays after StrictMode replays mount effects", async () => {
    const state = createDefaultSoccerState("Strict lifecycle");
    const { container, rerender } = render(
      <StrictMode>
        <OverlayRenderer type="soccer" state={state} />
      </StrictMode>
    );
    await frameText(container);
    const next = structuredClone(state);
    next.soccerPackage.activeOverlay = "scorebug";
    rerender(
      <StrictMode>
        <OverlayRenderer type="soccer" state={next} />
      </StrictMode>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector('[aria-label="Scorebug"]')).not.toBeNull(), { timeout: 3000 });
  });

  it("does not start a clock interval for a static soccer scene", () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const state = createDefaultSoccerState("Static Match");
    state.clock.running = false;
    state.soccerPackage.countdown.running = false;

    const { unmount } = render(<OverlayRenderer type="soccer" state={state} />);

    expect(intervalSpy).not.toHaveBeenCalled();
    unmount();
    intervalSpy.mockRestore();
  });

  it("does not tick an off-air soccer clock", () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const state = createDefaultSoccerState("Blank Match");
    state.clock.running = true;
    state.clock.startedAtMs = Date.now();
    state.soccerPackage.countdown.running = true;
    state.soccerPackage.countdown.startedAtMs = Date.now();
    state.soccerPackage.activeOverlay = null;

    const { unmount } = render(<OverlayRenderer type="soccer" state={state} />);
    expect(intervalSpy).not.toHaveBeenCalled();
    unmount();
    intervalSpy.mockRestore();
  });

  it("does not keep ticking after locally displayed soccer clocks have reached their stop", () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const now = Date.now();
    const state = createDefaultSoccerState("Finished Timers");
    state.clock = {
      ...state.clock,
      running: true,
      baseSeconds: 0,
      startedAtMs: now - 60_000,
      stopAtEnabled: true,
      stopAtSeconds: 10
    };
    state.soccerPackage.countdown = {
      ...state.soccerPackage.countdown,
      seconds: 5,
      running: true,
      startedAtMs: now - 60_000
    };

    const { unmount } = render(<OverlayRenderer type="soccer" state={state} />);

    expect(intervalSpy).not.toHaveBeenCalled();
    unmount();
    intervalSpy.mockRestore();
  });

  it("renders the Classic soccer matchup package", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.score.home = 3;
    state.score.away = 2;
    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await expect(frameText(container)).resolves.toContain("Test Match");
    await expect(frameText(container)).resolves.toContain("OpenOverlay United");
    await expect(frameText(container)).resolves.toContain("Skyline FC");
    await expect(frameText(container)).resolves.toContain("05:00");
  });

  it("renders the Rounded scorebug package with team abbreviations", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.overlayPackage = "rounded";
    state.soccerPackage.activeOverlay = "scorebug";
    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await expect(frameText(container)).resolves.toContain("OOU");
    await expect(frameText(container)).resolves.toContain("SKY");
  });

  it("renders a non-expired soccer temporary graphic", () => {
    const state = createDefaultSoccerState("Test Match");
    state.activeGraphics.push({
      id: "goal-1",
      kind: "goal",
      title: "Goal by #10",
      label: "Goal",
      team: "home",
      variant: "broadcast",
      placement: { x: 120, y: 760, width: 720, height: 160, scale: 1, preset: "custom" },
      startedAtMs: Date.now(),
      durationMs: 0,
      expiresAtMs: null
    });

    render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );

    expect(screen.getByRole("heading", { name: "Goal by #10" })).toBeInTheDocument();
  });

  it("does not render the soccer stats tracker", () => {
    const state = createDefaultSoccerState("Test Match");
    state.stats.shots = { home: 7, away: 4 };
    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );

    expect(container.querySelector(".statbug")).not.toBeInTheDocument();
  });

  it("applies soccer package color bank variables to the stage", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.overlayPackage = "rounded";
    state.soccerPackage.colorBanks.rounded.maroon = "#123456";
    state.soccerPackage.colorBanks.rounded.gold = "#fedcba";
    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );

    await waitFor(() => expect(frameBody(container)?.querySelector("#stage")).toBeTruthy());
    const stage = frameBody(container)?.querySelector<HTMLElement>("#stage");
    expect(stage?.style.getPropertyValue("--maroon")).toBe("#123456");
    expect(stage?.style.getPropertyValue("--gold")).toBe("#fedcba");
  });

  it("only marks requested soccer text fields as updated", async () => {
    const state = createDefaultSoccerState("Test Match");
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-event-title]")).toBeTruthy());
    expect(frameBody(container)?.querySelector("[data-bind-event-title]")?.classList.contains("text-updated")).toBe(false);

    const nextState = structuredClone(state);
    nextState.gameTitle = "Updated Match";
    nextState.soccerPackage.textAnimation = { id: 1, fields: ["event-title"] };
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-event-title]")?.classList.contains("text-updated")).toBe(true));
    expect(frameBody(container)?.querySelector("[data-bind-production]")?.classList.contains("text-updated")).toBe(false);
  });

  it("marks only requested soccer team logos as updated", async () => {
    const state = createDefaultSoccerState("Test Match");
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".full-team.home [data-bind-team-logo]")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.home.logoUrl = "/media/home-updated.png";
    nextState.soccerPackage.textAnimation = { id: 2, fields: ["home-logo"] };
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    await waitFor(() => expect(frameBody(container)?.querySelector(".full-team.home [data-bind-team-logo]")?.classList.contains("text-updated")).toBe(true));
    expect(frameBody(container)?.querySelector(".full-team.away [data-bind-team-logo]")?.classList.contains("text-updated")).toBe(false);
  });

  it("animates only the changed score without replaying lineup intro rows", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "lineup-panel";
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-lineup.overlay-entering")).toBeTruthy());
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-lineup.overlay-live")).toBeTruthy(), { timeout: 1400 });

    const nextState = structuredClone(state);
    nextState.score.home = 1;
    nextState.soccerPackage.textAnimation = { id: 3, fields: ["home-score"] };
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    expect(frameBody(container)?.querySelector(".overlay-lineup.overlay-entering")).toBeFalsy();
    expect(frameBody(container)?.querySelector(".lineup-list.lineup-text-updated")).toBeFalsy();
  });

  it("adds a score update class to the changed score", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "scorebug";
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-scorebug")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.score.home = 1;
    nextState.soccerPackage.textAnimation = { id: 4, fields: ["home-score"] };
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-score].score-increased")).toBeTruthy());
    expect(frameBody(container)?.querySelectorAll("[data-bind-score].score-increased")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(frameBody(container)?.querySelector("[data-bind-score].score-increased")).toBeTruthy();
    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-score].score-increased")).toBeFalsy(), { timeout: 500 });
  });

  it("renders a custom countdown label and safely switches to the small layout", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let rectCallCount = 0;
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        rectCallCount += 1;
        const rect =
          rectCallCount === 1
            ? { x: 520, y: 210, top: 210, left: 520, right: 1120, bottom: 420, width: 600, height: 210 }
            : { x: 1440, y: 760, top: 760, left: 1440, right: 1680, bottom: 850, width: 240, height: 90 };
        return { ...rect, toJSON: () => rect };
      }
    });

    try {
      const state = createDefaultSoccerState("Test Match");
      state.soccerPackage.activeOverlay = "countdown-timer";
      state.soccerPackage.countdown.label = "Halftime Clock";
      const { container, rerender } = render(
        <div style={{ width: 960, height: 540 }}>
          <OverlayRenderer type="soccer" state={state} />
        </div>
      );
      await expect(frameText(container)).resolves.toContain("Halftime Clock");

      const nextState = structuredClone(state);
      nextState.soccerPackage.countdown.mode = "small";
      nextState.soccerPackage.countdown.position = "bottom-right";
      rerender(
        <div style={{ width: 960, height: 540 }}>
          <OverlayRenderer type="soccer" state={nextState} />
        </div>
      );

      await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-countdown.countdown-small .timer-card")).toBeTruthy());
    } finally {
      Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: originalRect });
    }
  });

  it("keeps a soccer overlay mounted with the exit class after hiding it", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "full-matchup";
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-entering")).toBeTruthy());

    const hiddenState = structuredClone(state);
    hiddenState.soccerPackage.activeOverlay = null;
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={hiddenState} />
      </div>
    );

    expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-entering")).toBeFalsy();
    expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-exiting")).toBeTruthy();
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup")).toBeNull(), { timeout: 1600 });
  });

  it("delays the incoming soccer overlay when switching overlays", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "full-matchup";
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-entering")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.soccerPackage.activeOverlay = "scorebug";
    nextState.soccerPackage.selectedOverlay = "scorebug";
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    const body = frameBody(container);
    expect(body?.querySelector(".overlay-full-matchup.overlay-entering")).toBeTruthy();
    expect(body?.querySelector(".overlay-layer-exiting .overlay-full-matchup.overlay-exiting")).toBeFalsy();
    expect(body?.querySelector(".overlay-layer-active .overlay-scorebug.overlay-entering")).toBeFalsy();
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-layer-exiting .overlay-full-matchup.overlay-exiting")).toBeTruthy(), {
      timeout: 1600
    });
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-layer-active .overlay-scorebug.overlay-entering")).toBeTruthy(), {
      timeout: 2200
    });
  });

  it("morphs a lower matchup into its countdown state before showing the full countdown", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "lower-matchup";
    const { container, rerender } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={state} />
      </div>
    );
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-lower-matchup")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.soccerPackage.activeOverlay = "countdown-timer";
    nextState.soccerPackage.selectedOverlay = "countdown-timer";
    nextState.soccerPackage.countdown.running = true;
    nextState.soccerPackage.countdown.startedAtMs = Date.now();
    rerender(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="soccer" state={nextState} />
      </div>
    );

    const handoffBody = frameBody(container);
    expect(handoffBody?.querySelector("#stage")?.classList.contains("timer-activating")).toBe(false);
    expect(handoffBody?.querySelector(".overlay-layer-active .overlay-lower-matchup.overlay-entering")).toBeTruthy();
    expect(handoffBody?.querySelector(".overlay-layer-active .overlay-countdown")).toBeFalsy();
    await waitFor(() => expect(frameBody(container)?.querySelector("#stage")?.classList.contains("timer-activating")).toBe(true), { timeout: 1600 });
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-layer-active .overlay-countdown.overlay-entering")).toBeTruthy(), {
      timeout: 2400
    });
  });

  it("renders a church slide at the full stage origin without a phantom wall-clock countdown", () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const state = createDefaultChurchState("Sunday");
    const { container, unmount } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="church" state={state} />
      </div>
    );
    expect(screen.getByText(/Welcome/)).toBeInTheDocument();
    const fullscreen = container.querySelector<HTMLElement>('[data-element-id="churchFullscreen"]');
    expect(fullscreen?.style.left).toBe("0px");
    expect(fullscreen?.style.top).toBe("0px");
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(intervalSpy).not.toHaveBeenCalled();
    unmount();
    intervalSpy.mockRestore();
  });

  it("renders an active church lower third with selected copy and no generic duplicate", () => {
    const state = createDefaultChurchState("Sunday");
    state.activeGraphics.push({
      id: "lower-1",
      kind: "church-lower-third",
      title: "Pastor Jordan",
      subtitle: "Lead Pastor",
      variant: "glass",
      placement: state.elements.lowerThird.placement,
      startedAtMs: Date.now(),
      durationMs: 1_000,
      expiresAtMs: null
    });

    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="church" state={state} />
      </div>
    );

    expect(screen.getByRole("heading", { name: "Pastor Jordan" })).toBeInTheDocument();
    expect(screen.getByText("Lead Pastor")).toBeInTheDocument();
    expect(container.querySelectorAll(".church-lower-third")).toHaveLength(1);
    expect(container.querySelector(".temporary-graphic")).not.toBeInTheDocument();
  });

  it("renders a church countdown as remaining duration rather than local time", () => {
    const now = Date.now();
    const state = createDefaultChurchState("Sunday");
    state.activeGraphics.push({
      id: "countdown-1",
      kind: "countdown",
      title: "Service begins in",
      variant: "clean",
      placement: state.elements.countdown.placement,
      startedAtMs: now,
      durationMs: 90_000,
      expiresAtMs: now + 90_000
    });

    const { container } = render(
      <div style={{ width: 960, height: 540 }}>
        <OverlayRenderer type="church" state={state} />
      </div>
    );

    expect(screen.getByRole("timer")).toHaveTextContent("Service begins in");
    expect(screen.getByRole("timer")).toHaveTextContent("01:30");
    expect(container.querySelectorAll(".countdown-element")).toHaveLength(1);
    expect(container.querySelector(".temporary-graphic")).not.toBeInTheDocument();
  });
});
