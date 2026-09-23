import { CHURCH_BACKGROUND_PRESETS, makeId, type ChurchSlide, type ChurchState } from "./index.js";

export const MAX_SERVICE_FILE_BYTES = 2 * 1024 * 1024;

/** Include old or imported slides whose section was never listed in sections. */
export function churchSections(state: Pick<ChurchState, "sections" | "slides">): string[] {
  return [...new Set([...state.sections, ...state.slides.map((slide) => slide.section)])];
}

export function orderedChurchSlides(state: Pick<ChurchState, "sections" | "slides">): ChurchSlide[] {
  return churchSections(state).flatMap((section) => state.slides.filter((slide) => slide.section === section));
}

/** Blank lines or --- start a slide; verse/chorus headings label following slides. */
export function prepareChurchSlides(text: string, section: string, linesPerSlide = 4, reference = ""): ChurchSlide[] {
  if (!section.trim() || section.length > 200) throw new Error("Give this service item a title of 200 characters or fewer.");
  if (text.length > 100_000) throw new Error("Import up to 100,000 characters at a time.");
  const limit = Math.min(8, Math.max(1, Math.trunc(linesPerSlide) || 4));
  const slides: ChurchSlide[] = [];
  let lines: string[] = [];
  let label = "";
  function flush() {
    if (!lines.length) return;
    if (lines.join("\n").length > 10_000) throw new Error("A slide can contain up to 10,000 characters. Add line breaks to split this text.");
    slides.push({
      id: makeId("slide"),
      title: `${section} · ${slides.length + 1}`.slice(0, 200),
      section,
      type: "text",
      text: lines.join("\n"),
      label,
      reference: reference.slice(0, 300),
      backgroundColor: "#101827",
      textColor: "#ffffff",
      variant: "clean",
      fontSize: 76,
      textAlign: "center",
      backgroundDim: 40
    });
    lines = [];
  }
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line)) {
      flush();
      continue;
    }
    const heading = line.match(/^\[([^\]]{1,80})\]$/) || line.match(/^((?:verse|chorus|bridge|pre-chorus|intro|outro|refrain|tag)(?:\s+\d+)?):?$/i);
    if (heading) {
      flush();
      label = heading[1];
      continue;
    }
    // Keep pasted prose readable without asking volunteers to wrap every verse.
    let wrapped = "";
    for (const word of line.split(/\s+/)) {
      if (wrapped && wrapped.length + word.length + 1 > 48) {
        lines.push(wrapped);
        wrapped = "";
        if (lines.length >= limit) flush();
      }
      wrapped += `${wrapped ? " " : ""}${word}`;
    }
    if (wrapped) lines.push(wrapped);
    if (lines.length >= limit) flush();
  }
  flush();
  if (slides.length > 500) throw new Error("This text creates more than 500 slides. Import a smaller part.");
  return slides;
}

/** Portable service text and appearance. Media stays in the owner's library. */
export function exportChurchService(state: ChurchState): string {
  return JSON.stringify(
    {
      format: "openoverlay-service",
      version: 1,
      title: state.serviceTitle,
      sections: churchSections(state),
      slides: orderedChurchSlides(state).map(({ mediaId: _mediaId, mediaUrl: _mediaUrl, ...slide }) => ({ ...slide, type: "text" }))
    },
    null,
    2
  );
}

export function importChurchService(source: string): Pick<ChurchState, "sections" | "slides"> {
  if (new TextEncoder().encode(source).byteLength > MAX_SERVICE_FILE_BYTES) throw new Error("Service files must be 2 MiB or smaller.");
  const data: unknown = JSON.parse(source);
  if (
    !data ||
    typeof data !== "object" ||
    !("format" in data) ||
    data.format !== "openoverlay-service" ||
    !("version" in data) ||
    data.version !== 1 ||
    !("slides" in data) ||
    !Array.isArray(data.slides) ||
    data.slides.length > 500 ||
    !("sections" in data) ||
    !Array.isArray(data.sections) ||
    data.sections.length > 100
  ) {
    throw new Error("Choose an OpenOverlay service export (.json).");
  }
  const string = (value: unknown, max: number): string => {
    if (typeof value !== "string" || value.length > max) throw new Error("The service file contains an invalid text field.");
    return value;
  };
  const sections = data.sections.map((section) => string(section, 200));
  const slides: ChurchSlide[] = data.slides.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("The service file contains an invalid slide.");
    const slide = value as Record<string, unknown>;
    const color = (value: unknown) => {
      const result = string(value, 7);
      if (!/^#[0-9a-f]{6}$/i.test(result)) throw new Error("Invalid slide color.");
      return result;
    };
    return {
      id: makeId("slide"),
      type: "text",
      title: string(slide.title, 200),
      text: string(slide.text, 10_000),
      section: string(slide.section, 200),
      backgroundColor: color(slide.backgroundColor),
      textColor: color(slide.textColor),
      variant: "clean",
      label: slide.label === undefined ? "" : string(slide.label, 80),
      reference: slide.reference === undefined ? "" : string(slide.reference, 300),
      notes: slide.notes === undefined ? "" : string(slide.notes, 2000),
      fontSize: typeof slide.fontSize === "number" && Number.isFinite(slide.fontSize) ? Math.min(120, Math.max(32, slide.fontSize)) : 76,
      textAlign: slide.textAlign === "left" || slide.textAlign === "right" ? slide.textAlign : "center",
      backgroundPreset: CHURCH_BACKGROUND_PRESETS.find((preset) => preset === slide.backgroundPreset) ?? "solid",
      backgroundMotion: slide.backgroundMotion !== false,
      backgroundDim: typeof slide.backgroundDim === "number" && Number.isFinite(slide.backgroundDim) ? Math.min(90, Math.max(0, slide.backgroundDim)) : 40
    };
  });
  const normalized = churchSections({ sections, slides });
  if (normalized.length > 100) throw new Error("A service can contain up to 100 items.");
  return { sections: normalized, slides };
}
