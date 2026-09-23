import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSoccerState, type PresetSummary } from "@openoverlay/shared";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";

interface FakeSocket {
  handlers: Map<string, Array<(payload?: unknown) => void>>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn<() => void>>;
  emit(event: string, payload?: unknown): void;
}

const socketHarness = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

vi.mock("socket.io-client", () => ({
  io: vi.fn((_url: string, options?: { autoConnect?: boolean }) => {
    const handlers = new Map<string, Array<(payload?: unknown) => void>>();
    const socket = {
      handlers,
      on: vi.fn((event: string, callback: (payload?: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), callback]);
        return socket;
      }),
      disconnect: vi.fn(),
      connect: vi.fn(),
      emit(event: string, payload?: unknown) {
        for (const callback of handlers.get(event) ?? []) callback(payload);
      }
    } as FakeSocket & { on: ReturnType<typeof vi.fn> };
    if (options?.autoConnect !== false) socket.connect();
    socketHarness.sockets.push(socket);
    return socket;
  })
}));

import { OverlayPage, PresetEditor, PromptDialogProvider } from "./App";
import { CachedPages } from "./components/CachedPages";
import { AUTH_EXPIRED_EVENT, mediaApi, overlayApi, presetApi, teamApi } from "./lib/api";

describe("preset deletion realtime handling", () => {
  beforeEach(() => {
    socketHarness.sockets.splice(0);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(["overlay", "admin"])("does not open a socket for a discarded Strict Mode %s mount", async (role) => {
    const view = role === "overlay" ? renderTestOverlay(true) : renderTestEditor(true);
    await act(async () => {});
    expect(socketHarness.sockets).toHaveLength(2);
    expect(socketHarness.sockets[0]!.connect).not.toHaveBeenCalled();
    expect(socketHarness.sockets[1]!.connect).toHaveBeenCalledOnce();
    view.unmount();
  });

  it.each(["overlay", "admin"])("retries a server-initiated %s disconnect with backoff and cancels on unmount", async (role) => {
    vi.useFakeTimers();
    try {
      const view = role === "overlay" ? renderTestOverlay() : renderTestEditor();
      await act(async () => {});
      const socket = socketHarness.sockets[0]!;
      socket.connect.mockClear();
      act(() => {
        socket.emit("error:message", { error: "Realtime connection failed" });
        socket.emit("disconnect", "io server disconnect");
      });
      await act(async () => vi.advanceTimersByTime(1000));
      expect(socket.connect).toHaveBeenCalledTimes(1);
      act(() => {
        socket.emit("connect");
        socket.emit("disconnect", "io server disconnect");
      });
      await act(async () => vi.advanceTimersByTime(1000));
      expect(socket.connect).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(socket.connect).toHaveBeenCalledTimes(2);
      act(() => socket.emit("disconnect", "io server disconnect"));
      view.unmount();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(socket.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["overlay", "Overlay not found"],
    ["overlay", "Incompatible OpenOverlay API or realtime version"],
    ["admin", "Preset not found"],
    ["admin", "Authentication required"],
    ["admin", "Incompatible OpenOverlay API or realtime version"]
  ])("does not retry terminal %s error %s", async (role, error) => {
    vi.useFakeTimers();
    try {
      const view = role === "overlay" ? renderTestOverlay() : renderTestEditor();
      await act(async () => {});
      const socket = socketHarness.sockets[0]!;
      socket.connect.mockClear();
      act(() => {
        socket.emit("error:message", { error });
        socket.emit("disconnect", "io server disconnect");
      });
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(socket.connect).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses cached editor sockets and prevents a late refresh from replacing newer realtime state", async () => {
    const refresh = deferred<{ preset: PresetSummary }>();
    vi.spyOn(presetApi, "get").mockResolvedValueOnce({ preset: presetFixture() }).mockReturnValueOnce(refresh.promise);
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/*",
          element: (
            <PromptDialogProvider>
              <CachedPages>
                {(location) => (
                  <Routes location={location}>
                    <Route path="presets/:presetId" element={<PresetEditor />} />
                    <Route path="media" element={<p>Media</p>} />
                  </Routes>
                )}
              </CachedPages>
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Realtime Game" });
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    await act(async () => {
      await router.navigate("/dash/media");
    });
    expect(socketHarness.sockets[0]!.disconnect).toHaveBeenCalledOnce();
    await act(async () => {
      await router.navigate("/dash/presets/preset-1");
    });
    expect(screen.getByRole("heading", { name: "Realtime Game" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Loading game" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Match" })).toHaveClass("active");
    expect(socketHarness.sockets).toHaveLength(2);
    const newer = { ...presetFixture(), name: "Updated remotely", revision: 3 };
    act(() => socketHarness.sockets[1]!.emit("preset:update", newer));
    await act(async () => refresh.resolve({ preset: presetFixture() }));
    expect(screen.getByRole("heading", { name: "Updated remotely" })).toBeVisible();
  });

  it("ends the expired admin session when realtime rejects authentication", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    try {
      renderTestEditor();
      await screen.findByRole("heading", { name: "Realtime Game" });
      act(() => socketHarness.sockets[0]!.emit("error:message", { error: "Authentication required" }));
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
    }
  });

  it("clears a failed HTTP load warning when realtime recovers", async () => {
    vi.spyOn(overlayApi, "get").mockRejectedValue(new Error("Temporary outage"));
    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary outage");
    act(() => socketHarness.sockets[0]!.emit("state:update", presetFixture()));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not display a late HTTP failure after realtime has loaded the overlay", async () => {
    const pending = deferred<{ overlay: PresetSummary }>();
    vi.spyOn(overlayApi, "get").mockReturnValue(pending.promise);
    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );
    act(() => socketHarness.sockets[0]!.emit("state:update", presetFixture()));
    await act(async () => pending.reject(new Error("Late timeout")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a newer broadcast when an older action response arrives late", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    const pending = deferred<{ preset: PresetSummary }>();
    vi.spyOn(presetApi, "action").mockReturnValue(pending.promise);
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add point to OOU" }));
    const newer = presetFixture();
    newer.revision = 4;
    if ("score" in newer.state) newer.state.score.home = 2;
    act(() => socketHarness.sockets[0]!.emit("preset:update", newer));
    const older = presetFixture();
    older.revision = 3;
    if ("score" in older.state) older.state.score.home = 1;
    await act(async () => pending.resolve({ preset: older }));
    expect(document.querySelector(".score-control strong")).toHaveTextContent("2");
  });

  it("accepts a committed broadcast after the action response fails", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    const pending = deferred<{ preset: PresetSummary }>();
    vi.spyOn(presetApi, "action").mockReturnValue(pending.promise);
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add point to OOU" }));
    await waitFor(() => expect(presetApi.action).toHaveBeenCalled());
    const committed = presetFixture();
    committed.revision = 3;
    if ("score" in committed.state) committed.state.score.home = 1;
    act(() => socketHarness.sockets[0]!.emit("preset:update", committed));
    await act(async () => pending.reject(new Error("Response lost")));
    expect(document.querySelector(".score-control strong")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("discards obsolete undo history when a concurrent edit beats its acknowledgement", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    const pending = deferred<{ preset: PresetSummary }>();
    vi.spyOn(presetApi, "action").mockReturnValue(pending.promise);
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add point to OOU" }));
    const first = presetFixture();
    first.revision = 3;
    if ("score" in first.state) first.state.score.home = 1;
    await act(async () => pending.resolve({ preset: first }));
    const undo = deferred<{ preset: PresetSummary }>();
    vi.spyOn(presetApi, "patch").mockReturnValue(undo.promise);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(presetApi.patch).toHaveBeenCalled());
    const remote = presetFixture();
    remote.revision = 5;
    if ("score" in remote.state) remote.state.score.home = 7;
    act(() => socketHarness.sockets[0]!.emit("preset:update", remote));
    const acknowledged = presetFixture();
    acknowledged.revision = 4;
    await act(async () => undo.resolve({ preset: acknowledged }));
    expect(document.querySelector(".score-control strong")).toHaveTextContent("7");
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("preserves a failed autosave draft when another operator broadcasts an update", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    vi.spyOn(presetApi, "patch").mockRejectedValue(new Error("Save failed"));
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);
    const period = await screen.findByLabelText("Period", { exact: true });
    fireEvent.change(period, { target: { value: "MY DRAFT" } });
    await screen.findByRole("button", { name: "Retry save" });
    const remote = presetFixture();
    remote.revision = 3;
    act(() => socketHarness.sockets[0]!.emit("preset:update", remote));
    expect(period).toHaveValue("MY DRAFT");
  });

  it("clears a public overlay, aborts its stale HTTP load, and stays cleared", async () => {
    const pendingOverlay = deferred<{ overlay: PresetSummary }>();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(overlayApi, "get").mockImplementation((_id, signal) => {
      requestSignal = signal;
      return pendingOverlay.promise;
    });

    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(socketHarness.sockets).toHaveLength(1));
    const socket = socketHarness.sockets[0]!;
    act(() => socket.emit("preset:deleted", deletionEvent()));

    expect(await screen.findByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(requestSignal?.aborted).toBe(true);
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();

    await act(async () => pendingOverlay.resolve({ overlay: presetFixture() }));
    expect(screen.getByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();
  });

  it("replaces an editor with a terminal deleted state and ignores its late load", async () => {
    const pendingPreset = deferred<{ preset: PresetSummary }>();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(presetApi, "get").mockImplementation((_id, signal) => {
      requestSignal = signal;
      return pendingPreset.promise;
    });
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );

    render(<RouterProvider router={router} />);
    await waitFor(() => expect(socketHarness.sockets).toHaveLength(1));
    const socket = socketHarness.sockets[0]!;
    act(() => socket.emit("preset:deleted", deletionEvent()));

    expect(await screen.findByRole("heading", { name: "Production deleted" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("This production was deleted in another session");
    expect(screen.getByRole("link", { name: "Return to productions" })).toHaveAttribute("href", "/dash");
    expect(requestSignal?.aborted).toBe(true);
    expect(socket.disconnect).toHaveBeenCalledOnce();

    await act(async () => pendingPreset.resolve({ preset: presetFixture() }));
    expect(screen.getByRole("heading", { name: "Production deleted" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Realtime Game" })).not.toBeInTheDocument();
  });

  it("clears a previously loaded overlay when reconnect reports it missing", async () => {
    vi.spyOn(overlayApi, "get").mockResolvedValue({ overlay: presetFixture() });
    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(document.querySelector(".overlay-viewport")).toBeInTheDocument());
    const socket = socketHarness.sockets[0]!;

    act(() => {
      socket.emit("disconnect");
      socket.emit("connect");
    });
    act(() => socket.emit("error:message", { error: "Realtime connection failed" }));
    expect(document.querySelector(".overlay-viewport")).toBeInTheDocument();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Overlay not found", code: 404 }));
    expect(document.querySelector(".overlay-viewport")).toBeInTheDocument();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Overlay not found" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("closes a previously loaded editor when reconnect reports its preset missing", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter(
      [
        {
          path: "/dash/presets/:presetId",
          element: (
            <PromptDialogProvider>
              <PresetEditor />
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/presets/preset-1"] }
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Realtime Game" })).toBeVisible();
    const socket = socketHarness.sockets[0]!;

    act(() => {
      socket.emit("disconnect");
      socket.emit("connect");
    });
    act(() => socket.emit("error:message", { error: "Authentication required" }));
    expect(screen.getByRole("heading", { name: "Realtime Game" })).toBeVisible();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Preset not found", retryable: false }));
    expect(screen.getByRole("heading", { name: "Realtime Game" })).toBeVisible();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Preset not found" }));
    expect(await screen.findByRole("heading", { name: "Production deleted" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Realtime Game" })).not.toBeInTheDocument();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });
});

function deletionEvent() {
  return { id: "preset-1", publicId: "public-1", revision: 3 };
}

function presetFixture(): PresetSummary {
  return {
    id: "preset-1",
    publicId: "public-1",
    name: "Realtime Game",
    type: "soccer",
    revision: 2,
    updatedAt: "2026-08-11T00:00:00.000Z",
    state: createDefaultSoccerState("Realtime Game")
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderTestEditor(strict = false) {
  vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
  vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [], nextCursor: null });
  vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
  const router = createMemoryRouter(
    [
      {
        path: "/dash/presets/:presetId",
        element: (
          <PromptDialogProvider>
            <PresetEditor />
          </PromptDialogProvider>
        )
      }
    ],
    { initialEntries: ["/dash/presets/preset-1"] }
  );
  const editor = <RouterProvider router={router} />;
  return render(strict ? <StrictMode>{editor}</StrictMode> : editor);
}

function renderTestOverlay(strict = false) {
  vi.spyOn(overlayApi, "get").mockResolvedValue({ overlay: presetFixture() });
  const overlay = (
    <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
      <Routes>
        <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{overlay}</StrictMode> : overlay);
}
