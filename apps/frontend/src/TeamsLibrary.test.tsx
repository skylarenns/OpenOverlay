import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTeam, type TeamLibraryEntry } from "@openoverlay/shared";
import { createMemoryRouter, RouterProvider, Routes, Route } from "react-router-dom";

const apiMocks = vi.hoisted(() => ({
  listTeams: vi.fn(),
  createTeam: vi.fn(),
  patchTeam: vi.fn(),
  removeTeam: vi.fn(),
  listMedia: vi.fn(),
  uploadMedia: vi.fn()
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      list: apiMocks.listTeams,
      create: apiMocks.createTeam,
      patch: apiMocks.patchTeam,
      remove: apiMocks.removeTeam
    },
    mediaApi: {
      ...actual.mediaApi,
      list: apiMocks.listMedia,
      upload: apiMocks.uploadMedia
    }
  };
});

import { PromptDialogProvider, TeamFields, TeamsLibrary } from "./App";
import { CachedPages } from "./components/CachedPages";
import { ApiError } from "./lib/api";

function makeTeam(overrides: Partial<TeamLibraryEntry> = {}): TeamLibraryEntry {
  return {
    ...defaultTeam("home"),
    id: "team-1",
    revision: 1,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    ...overrides
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

function renderTeamsLibrary() {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <PromptDialogProvider>
            <TeamsLibrary />
          </PromptDialogProvider>
        )
      }
    ],
    { initialEntries: ["/dash/teams"] }
  );
  return render(<RouterProvider router={router} />);
}

describe("TeamsLibrary concurrency and reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMocks.listMedia.mockResolvedValue({ media: [] });
    apiMocks.uploadMedia.mockResolvedValue({ media: mediaFixture() });
    apiMocks.removeTeam.mockResolvedValue({ ok: true });
    apiMocks.patchTeam.mockImplementation((_id: string, input: TeamLibraryEntry) =>
      Promise.resolve({
        team: {
          ...input,
          revision: input.revision + 1,
          updatedAt: "2026-08-10T12:01:00.000Z"
        }
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("locks the deleting team immediately and prevents duplicate deletion", async () => {
    const removal = deferred<{ ok: boolean }>();
    apiMocks.listTeams.mockResolvedValue({ teams: [makeTeam()] });
    apiMocks.removeTeam.mockReturnValue(removal.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTeamsLibrary();
    const button = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Deleting");
    await act(async () => removal.resolve({ ok: true }));
    expect(apiMocks.removeTeam).toHaveBeenCalledOnce();
  });

  it("keeps cached team edits when a delayed background refresh returns", async () => {
    const initial = makeTeam({ fullName: "Original team" });
    const refresh = deferred<{ teams: TeamLibraryEntry[] }>();
    apiMocks.listTeams.mockResolvedValueOnce({ teams: [initial] }).mockReturnValueOnce(refresh.promise);
    const router = createMemoryRouter(
      [
        {
          path: "/dash/*",
          element: (
            <PromptDialogProvider>
              <CachedPages>
                {(location) => (
                  <Routes location={location}>
                    <Route path="teams" element={<TeamsLibrary />} />
                    <Route path="media" element={<p>Media</p>} />
                  </Routes>
                )}
              </CachedPages>
            </PromptDialogProvider>
          )
        }
      ],
      { initialEntries: ["/dash/teams"] }
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("textbox", { name: "Team name" })).toHaveValue("Original team");
    await act(async () => {
      await router.navigate("/dash/media");
    });
    await act(async () => {
      await router.navigate("/dash/teams");
    });
    expect(screen.queryByRole("status", { name: "Loading teams" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Team name" }), { target: { value: "Fresh edit" } });
    await act(async () => refresh.resolve({ teams: [initial] }));
    expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Fresh edit");
    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(apiMocks.patchTeam.mock.calls[0]?.[1]).toMatchObject({ fullName: "Fresh edit" });
  });

  it("renders teams without waiting for optional media", async () => {
    const media = deferred<{ media: never[] }>();
    apiMocks.listTeams.mockResolvedValue({ teams: [makeTeam({ fullName: "Ready Team" })] });
    apiMocks.listMedia.mockReturnValue(media.promise);
    renderTeamsLibrary();
    expect(await screen.findByDisplayValue("Ready Team")).toBeVisible();
    await act(async () => media.resolve({ media: [] }));
  });

  it("retries failed saved logos without reloading or discarding a team draft", async () => {
    apiMocks.listTeams.mockResolvedValue({ teams: [makeTeam({ fullName: "Ready Team" })] });
    apiMocks.listMedia.mockRejectedValueOnce(new Error("media unavailable")).mockResolvedValueOnce({ media: [] });
    renderTeamsLibrary();
    const name = await screen.findByRole("textbox", { name: "Team name" });
    fireEvent.change(name, { target: { value: "Local edit" } });
    const retry = await screen.findByRole("button", { name: "Retry logos" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("No saved logos yet.")).toBeVisible());
    expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Local edit");
    expect(apiMocks.listTeams).toHaveBeenCalledOnce();
    expect(apiMocks.listMedia).toHaveBeenCalledTimes(2);
  });

  it("preserves a newly selected team when an earlier deletion finishes", async () => {
    const removal = deferred<{ ok: boolean }>();
    apiMocks.listTeams.mockResolvedValue({
      teams: [makeTeam({ id: "a", fullName: "Alpha" }), makeTeam({ id: "b", fullName: "Bravo" }), makeTeam({ id: "c", fullName: "Charlie" })]
    });
    apiMocks.removeTeam.mockReturnValue(removal.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTeamsLibrary();
    await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.removeTeam).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: /Charlie/ }));
    expect(screen.getByDisplayValue("Charlie")).toBeVisible();
    await act(async () => removal.resolve({ ok: true }));
    expect(screen.getByDisplayValue("Charlie")).toBeVisible();
  });

  it("keeps a conflicted draft until explicit discard, then loads the latest server copy", async () => {
    const initial = makeTeam({ fullName: "Original team" });
    const remote = makeTeam({ fullName: "Remote team", coach: "Remote coach", revision: 2 });
    const firstPatch = deferred<{ team: TeamLibraryEntry }>();
    apiMocks.listTeams.mockResolvedValue({ teams: [initial] });
    apiMocks.patchTeam.mockReturnValueOnce(firstPatch.promise);
    renderTeamsLibrary();

    const nameInput = await screen.findByRole("textbox", { name: "Team name" });
    fireEvent.change(nameInput, { target: { value: "Local stale team" } });
    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledOnce(), { timeout: 2_000 });
    fireEvent.change(screen.getByRole("textbox", { name: "Coach" }), { target: { value: "Queued stale coach" } });
    await act(async () => {
      firstPatch.reject(new ApiError("revision conflict", 409, {}));
      await firstPatch.promise.catch(() => undefined);
    });
    await screen.findByText(/changed in another tab/i, {}, { timeout: 2_000 });

    expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Local stale team");

    apiMocks.listTeams.mockResolvedValueOnce({ teams: [remote] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Remote team");
      expect(screen.getByRole("textbox", { name: "Coach" })).toHaveValue("Remote coach");
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    });
    expect(apiMocks.patchTeam).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByRole("textbox", { name: "Coach" }), { target: { value: "Updated coach" } });
    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(apiMocks.patchTeam.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        fullName: "Remote team",
        coach: "Updated coach",
        revision: 2
      })
    );
  });

  it("retries a canceled pending autosave when deletion fails", async () => {
    const initial = makeTeam({ fullName: "Original team" });
    apiMocks.listTeams.mockResolvedValue({ teams: [initial] });
    apiMocks.removeTeam.mockRejectedValueOnce(new Error("Delete failed offline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTeamsLibrary();

    const nameInput = await screen.findByRole("textbox", { name: "Team name" });
    fireEvent.change(nameInput, { target: { value: "Unsaved local team" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await screen.findByText("Delete failed offline");
    expect(apiMocks.removeTeam).toHaveBeenCalledWith(initial.id, initial.revision);
    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(apiMocks.patchTeam.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        fullName: "Unsaved local team"
      })
    );
  });

  it("waits for an in-flight save and deletes with the resulting server revision", async () => {
    const initial = makeTeam({ fullName: "Original team", revision: 1 });
    const saved = makeTeam({ fullName: "Saved team", revision: 2 });
    const inFlightSave = deferred<{ team: TeamLibraryEntry }>();
    apiMocks.listTeams.mockResolvedValue({ teams: [initial] });
    apiMocks.patchTeam.mockReturnValueOnce(inFlightSave.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTeamsLibrary();

    const nameInput = await screen.findByRole("textbox", { name: "Team name" });
    fireEvent.change(nameInput, { target: { value: "Saved team" } });
    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledOnce(), { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(apiMocks.removeTeam).not.toHaveBeenCalled();

    await act(async () => inFlightSave.resolve({ team: saved }));
    await waitFor(() => expect(apiMocks.removeTeam).toHaveBeenCalledWith(initial.id, 2));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Original team|Saved team/ })).not.toBeInTheDocument());
  });

  it("reconciles the editor with the canonical team returned by the server", async () => {
    const initial = makeTeam({ fullName: "Original team" });
    const normalized = makeTeam({
      fullName: "Normalized team",
      revision: 2,
      updatedAt: "2026-08-10T12:01:00.000Z"
    });
    apiMocks.listTeams.mockResolvedValue({ teams: [initial] });
    apiMocks.patchTeam.mockResolvedValueOnce({ team: normalized });
    renderTeamsLibrary();

    const nameInput = await screen.findByRole("textbox", { name: "Team name" });
    fireEvent.change(nameInput, { target: { value: "   unnormalized team   " } });

    await waitFor(() => expect(apiMocks.patchTeam).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(nameInput).toHaveValue("Normalized team"));
    expect(screen.getByRole("heading", { name: "Normalized team" })).toBeInTheDocument();
  });

  it("does not let a late initial list response erase a team created while loading", async () => {
    const initialList = deferred<{ teams: TeamLibraryEntry[] }>();
    const created = makeTeam({ id: "team-created", fullName: "Created team" });
    const stale = makeTeam({ id: "team-stale", fullName: "Stale team" });
    apiMocks.listTeams.mockReturnValue(initialList.promise);
    apiMocks.createTeam.mockResolvedValue({ team: created });
    renderTeamsLibrary();

    fireEvent.click(screen.getByRole("button", { name: "New Team" }));
    const dialog = await screen.findByRole("dialog", { name: "New team" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Team name" }), { target: { value: "Created team" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create team" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Created team"));
    await act(async () => {
      initialList.resolve({ teams: [stale] });
      await initialList.promise;
    });

    expect(screen.getByRole("textbox", { name: "Team name" })).toHaveValue("Created team");
    expect(screen.queryByText("Stale team")).not.toBeInTheDocument();
  });

  it("cancels a logo upload when the editor switches to another team", async () => {
    const upload = deferred<{ media: ReturnType<typeof mediaFixture> }>();
    apiMocks.uploadMedia.mockReturnValueOnce(upload.promise);
    const onChange = vi.fn();
    const first = makeTeam({ id: "team-first", primaryColor: "#123456", secondaryColor: "#abcdef" });
    const second = makeTeam({ id: "team-second", fullName: "Second team", primaryColor: "#654321", secondaryColor: "#fedcba" });
    const { rerender } = render(<TeamFields team={first} media={[]} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Upload team logo"), {
      target: { files: [new File(["logo"], "logo.png", { type: "image/png" })] }
    });
    await waitFor(() => expect(apiMocks.uploadMedia).toHaveBeenCalledOnce());
    const signal = apiMocks.uploadMedia.mock.calls[0]?.[1] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);

    rerender(<TeamFields team={second} media={[]} onChange={onChange} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => upload.resolve({ media: mediaFixture() }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

function mediaFixture() {
  return {
    id: "media-1",
    publicId: "public-media-1",
    filename: "media-1-logo.png",
    originalFilename: "logo.png",
    mimeType: "image/png",
    width: 100,
    height: 100,
    sizeBytes: 4,
    createdAt: "2026-08-10T12:00:00.000Z",
    url: "/api/v1/media/file/public-media-1"
  };
}
