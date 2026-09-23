import { Activity, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultChurchState, prepareChurchSlides, type ChurchState } from "@openoverlay/shared";
import { mediaApi } from "../lib/api";
import { ChurchWorkspace } from "./ChurchWorkspace";
import { ChurchStageScreen } from "./ChurchPresentation";
import { OverlayRenderer } from "./OverlayRenderer";

function fixture() {
  const state = createDefaultChurchState("Sunday");
  state.sections = ["Welcome", "Song", "Message"];
  state.slides = [
    ...prepareChurchSlides("Welcome everyone", "Welcome"),
    ...prepareChurchSlides("[Verse 1]\nFirst verse\n\n[Chorus]\nSing together", "Song"),
    ...prepareChurchSlides("A reading", "Message", 4, "Reading reference")
  ];
  state.selectedSlideId = state.slides[0].id;
  state.onAirSlide = structuredClone(state.slides[0]);
  return state;
}
function Editor() {
  const [state, setState] = useState(fixture());
  return (
    <>
      <ChurchWorkspace state={state} media={[]} cues={null} commitState={(next) => setState(next as ChurchState)} />
      <div data-testid="output">
        <OverlayRenderer type="church" state={state} />
      </div>
      <div data-testid="stage">
        <ChurchStageScreen state={state} />
      </div>
    </>
  );
}

describe("Sunday service operation", () => {
  it("keeps an empty service item off preview and cannot publish another item's slide", () => {
    function EmptyItemEditor() {
      const [state, setState] = useState(() => ({ ...fixture(), sections: [...fixture().sections, "Empty"] }));
      return (
        <>
          <ChurchWorkspace state={state} media={[]} cues={null} commitState={(next) => setState(next as ChurchState)} />
          <div data-testid="output">
            <OverlayRenderer type="church" state={state} />
          </div>
        </>
      );
    }
    render(<EmptyItemEditor />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Service order" })).getByRole("button", { name: /Empty/ }));
    expect(screen.getByRole("group", { name: "Selected slide preview" })).toHaveTextContent("No slide selected");
    expect(screen.getByRole("button", { name: "Show slide" })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(screen.getByTestId("output")).toHaveTextContent("Welcome everyone");
  });
  it("previews another item safely and advances live in service order instead of the preview selection", () => {
    render(<Editor />);
    const output = screen.getByTestId("output");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Service order" })).getByRole("button", { name: /Message/ }));
    expect(output).toHaveTextContent("Welcome everyone");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(output).toHaveTextContent("First verse");
    expect(screen.getByTestId("stage")).toHaveTextContent("Sing together");
    fireEvent.keyDown(screen.getByRole("button", { name: /^Preview Song · 1, slide/ }), { key: "ArrowRight" });
    expect(output).toHaveTextContent("Sing together");
  });
  it("blackout and text clear restore the exact live content; shortcuts do not fire while typing or held", () => {
    render(<Editor />);
    const output = screen.getByTestId("output");
    fireEvent.keyDown(document.body, { key: "b" });
    expect(within(output).getByLabelText("Blackout")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "b", repeat: true });
    expect(within(output).getByLabelText("Blackout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore screen" }));
    expect(output).toHaveTextContent("Welcome everyone");
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowRight" });
    expect(output).toHaveTextContent("Welcome everyone");
    fireEvent.click(screen.getByRole("button", { name: "Clear text" }));
    expect(output).not.toHaveTextContent("Welcome everyone");
    expect(screen.getByTestId("stage")).toHaveTextContent("Welcome everyone");
    fireEvent.click(screen.getByRole("button", { name: "Restore text" }));
    expect(output).toHaveTextContent("Welcome everyone");
  });
  it("blocks keyboard output changes when saving or a conflict prevents mutations", () => {
    const commitState = vi.fn();
    render(<ChurchWorkspace state={fixture()} media={[]} cues={null} commitState={commitState} disabled />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "b" });
    expect(commitState).not.toHaveBeenCalled();
  });
  it("protects live item deletion and reaches the end without wrapping", () => {
    render(<Editor />);
    expect(screen.getByRole("button", { name: "Delete item", hidden: true })).toBeDisabled();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByTestId("output")).toHaveTextContent("A reading");
    expect(screen.getByTestId("output")).toHaveTextContent("Reading reference");
  });
});

describe("church image upload", () => {
  it("allows another upload after a cached page aborts an in-flight upload", async () => {
    const upload = vi
      .spyOn(mediaApi, "upload")
      .mockImplementation(
        (_file, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      );
    try {
      const view = render(
        <Activity mode="visible">
          <Editor />
        </Activity>
      );
      fireEvent.click(screen.getByText("Edit slide", { selector: "summary" }));
      fireEvent.change(screen.getByLabelText("Upload slide image"), { target: { files: [new File(["image"], "background.png", { type: "image/png" })] } });
      expect(screen.getByLabelText("Upload slide image")).toBeDisabled();
      await act(async () =>
        view.rerender(
          <Activity mode="hidden">
            <Editor />
          </Activity>
        )
      );
      view.rerender(
        <Activity mode="visible">
          <Editor />
        </Activity>
      );
      expect(screen.getByLabelText("Upload slide image")).toBeEnabled();
      expect(screen.getByTestId("output")).toHaveTextContent("Welcome everyone");
    } finally {
      upload.mockRestore();
    }
  });

  it("attaches an upload to the original draft without overwriting edits made while it was uploading", async () => {
    let finish!: (value: Awaited<ReturnType<typeof mediaApi.upload>>) => void;
    const upload = vi.spyOn(mediaApi, "upload").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    try {
      render(<Editor />);
      fireEvent.click(screen.getByText("Edit slide", { selector: "summary" }));
      fireEvent.change(screen.getByLabelText("Upload slide image"), { target: { files: [new File(["image"], "background.png", { type: "image/png" })] } });
      fireEvent.change(screen.getByLabelText("Text", { selector: "textarea" }), { target: { value: "Edited during upload" } });
      await act(async () =>
        finish({
          media: {
            id: "image",
            publicId: "public-image",
            filename: "background.png",
            originalFilename: "background.png",
            mimeType: "image/png",
            sizeBytes: 5,
            url: "/api/media/file/public-image",
            createdAt: "2026-09-12",
            width: 1920,
            height: 1080,
            thumbnailUrl: undefined
          }
        })
      );
      expect(screen.getByLabelText("Text", { selector: "textarea" })).toHaveValue("Edited during upload");
      expect(screen.getByTestId("output")).toHaveTextContent("Welcome everyone");
      expect(screen.getByTestId("output").querySelector("img")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show slide" }));
      expect(screen.getByTestId("output")).toHaveTextContent("Edited during upload");
      expect(screen.getByTestId("output").querySelector("img")).not.toBeNull();
    } finally {
      upload.mockRestore();
    }
  });
});
