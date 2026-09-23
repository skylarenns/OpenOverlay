import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Copy, Download, Image, Music2, Plus, Presentation, Trash2, Upload } from "lucide-react";
import {
  churchOnAirSlide,
  churchSections,
  orderedChurchSlides,
  prepareChurchSlides,
  importChurchService,
  MAX_PRESET_STATE_BYTES,
  MAX_SERVICE_FILE_BYTES,
  exportChurchService,
  makeId,
  type ChurchBackgroundPreset,
  type ChurchSlide,
  type ChurchState,
  type PresetState
} from "@openoverlay/shared";
import { mediaApi, type MediaItem } from "../lib/api";
import { ChurchBackgroundPicker, ChurchSlideContent } from "./ChurchPresentation";
import { announceMediaUpload, MediaPicker } from "./MediaPicker";

interface Props {
  state: ChurchState;
  media: MediaItem[];
  commitState: (state: PresetState) => void;
  cues: ReactNode;
  outputUrl?: string;
  disabled?: boolean;
}

type ItemKind = "song" | "scripture" | "announcement";

export function ChurchWorkspace({ state, media, commitState, cues, outputUrl, disabled = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const latest = useRef({ state, commitState, disabled });
  latest.current = { state, commitState, disabled };
  const [uploadedMedia, setUploadedMedia] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const availableMedia = [...media, ...uploadedMedia.filter((item) => !media.some((existing) => existing.id === item.id))];
  useEffect(() => () => uploadController.current?.abort(), []);
  const onAir = churchOnAirSlide(state);
  const ordered = orderedChurchSlides(state);
  const sections = churchSections(state);
  const selectedCandidate = state.slides.find((slide) => slide.id === state.selectedSlideId);
  const [sectionChoice, setSectionChoice] = useState<string | null>(null);
  const section = sectionChoice !== null && sections.includes(sectionChoice) ? sectionChoice : (selectedCandidate?.section ?? sections[0] ?? "Service");
  const sectionSlides = ordered.filter((slide) => slide.section === section);
  const selected = selectedCandidate?.section === section ? selectedCandidate : sectionSlides[0];
  const [editing, setEditing] = useState(() => !selected?.text && !(window.matchMedia?.("(max-width: 640px)").matches ?? false));
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState<ItemKind | null>(null);
  const [imported, setImported] = useState<ReturnType<typeof importChurchService> | null>(null);
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [stageDraft, setStageDraft] = useState(state.stageMessage ?? "");
  const liveIndex = onAir ? ordered.findIndex((slide) => slide.id === onAir.id) : -1;
  const isLive = Boolean(onAir && state.elements.fullscreenSlide.visible);
  const liveMatches = isLive && !state.blackout && !state.textCleared && JSON.stringify(onAir) === JSON.stringify(selected);
  const hasLiveItem = isLive && sectionSlides.some((slide) => slide.id === onAir?.id);

  useEffect(() => {
    setStageDraft(state.stageMessage ?? "");
  }, [state.stageMessage]);

  function commitDraft(patch: Partial<ChurchState>) {
    if (disabled) return;
    commitState({ ...state, onAirSlide: onAir ? structuredClone(onAir) : null, ...patch });
  }
  function show(slide = selected) {
    if (!slide || disabled) return;
    setSectionChoice(slide.section);
    commitState({
      ...state,
      selectedSlideId: slide.id,
      onAirSlide: structuredClone(slide),
      blackout: false,
      textCleared: false,
      elements: { ...state.elements, fullscreenSlide: { ...state.elements.fullscreenSlide, visible: true } }
    });
  }
  function step(delta: number) {
    const target = liveIndex + delta;
    if (target >= 0 && target < ordered.length) show(ordered[target]);
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (disabled || composer || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || root.current?.closest("[inert]")) return;
      if (document.querySelector("dialog[open], [role='dialog']")) return;
      const slideControl = target?.closest(".church-thumbnail, .church-service-item");
      if (!slideControl && target?.closest("input, textarea, select, button, a, summary, [contenteditable]")) return;
      if (event.key === "ArrowRight" || event.key === " ") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        show();
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        commitDraft({ blackout: !state.blackout });
      } else if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        commitDraft({ textCleared: !state.textCleared });
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function uploadImage(file: File | undefined) {
    if (!file || !selected || uploading || disabled) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose an image smaller than 10 MB.");
      return;
    }
    const slideId = selected.id;
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    setError("");
    try {
      const { media: item } = await mediaApi.upload(file, controller.signal);
      if (controller.signal.aborted) return;
      setUploadedMedia((items) => [...items, item]);
      announceMediaUpload(item);
      const current = latest.current;
      if (!current.disabled && current.state.slides.some((slide) => slide.id === slideId)) {
        const live = churchOnAirSlide(current.state);
        current.commitState({
          ...current.state,
          onAirSlide: live ? structuredClone(live) : null,
          slides: current.state.slides.map((slide) =>
            slide.id === slideId ? { ...slide, mediaId: item.id, mediaUrl: item.url, type: "image", backgroundPreset: "solid" } : slide
          )
        });
        setNotice("Image added to the draft slide. Show slide when ready.");
      } else setNotice("Image uploaded. Choose it from Image/background when editing is available.");
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not upload the image.");
    } finally {
      // Cached pages retain state when their effects abort the request.
      setUploading(false);
      if (uploadController.current === controller) uploadController.current = null;
    }
  }
  function updateSlide(patch: Partial<ChurchSlide>) {
    if (!selected) return;
    commitDraft({ slides: state.slides.map((slide) => (slide.id === selected.id ? { ...slide, ...patch } : slide)) });
  }
  function select(slide: ChurchSlide) {
    setSectionChoice(slide.section);
    commitDraft({ selectedSlideId: slide.id });
  }
  function addSlide(type: "text" | "image") {
    if (state.slides.length >= 500) {
      setError("A service can contain up to 500 slides.");
      return;
    }
    const slide: ChurchSlide = {
      id: makeId("slide"),
      section,
      title: `${type === "text" ? "Text" : "Image"} ${sectionSlides.length + 1}`,
      type,
      text: "",
      backgroundColor: selected?.backgroundColor ?? "#101827",
      textColor: selected?.textColor ?? "#ffffff",
      variant: "clean",
      fontSize: selected?.fontSize ?? 76,
      backgroundPreset: selected?.backgroundPreset ?? "solid",
      backgroundMotion: selected?.backgroundMotion ?? true,
      backgroundDim: selected?.backgroundDim ?? 0
    };
    commitDraft({ sections: sections.includes(section) ? sections : [...sections, section], slides: [...state.slides, slide], selectedSlideId: slide.id });
    setEditing(true);
  }
  function moveSlide(delta: number) {
    if (!selected) return;
    const index = sectionSlides.findIndex((slide) => slide.id === selected.id);
    const target = sectionSlides[index + delta];
    if (!target) return;
    const slides = [...state.slides];
    const a = slides.findIndex((slide) => slide.id === selected.id),
      b = slides.findIndex((slide) => slide.id === target.id);
    [slides[a], slides[b]] = [slides[b], slides[a]];
    commitDraft({ slides });
  }
  function renameSection(name: string) {
    const title = name.trim();
    if (!title || title === section) return;
    if (sections.includes(title)) {
      setError("That item title already exists. Choose a different title.");
      return;
    }
    commitDraft({
      sections: sections.map((item) => (item === section ? title : item)),
      slides: state.slides.map((slide) => (slide.section === section ? { ...slide, section: title } : slide))
    });
    setSectionChoice(title);
  }
  function moveSection(delta: number) {
    const next = [...sections],
      index = next.indexOf(section),
      target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commitDraft({ sections: next });
  }
  function uniqueTitle(title: string, used: string[]) {
    let name = title,
      suffix = 2;
    while (used.includes(name)) name = `${title.slice(0, 185)} (${suffix++})`;
    return name;
  }
  function append(content: ReturnType<typeof importChurchService>) {
    if (state.slides.length + content.slides.length > 500 || sections.length + content.sections.length > 100) {
      setError("A service can contain up to 100 items and 500 slides.");
      return;
    }
    const names = [...sections];
    const mapped = new Map<string, string>();
    content.sections.forEach((title) => {
      const name = uniqueTitle(title, names);
      mapped.set(title, name);
      names.push(name);
    });
    const slides = content.slides.map((slide) => ({ ...slide, id: makeId("slide"), section: mapped.get(slide.section) ?? slide.section }));
    const next = { ...state, sections: names, slides: [...state.slides, ...slides], selectedSlideId: slides[0]?.id ?? selected?.id };
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_PRESET_STATE_BYTES) {
      setError("This service exceeds the 512 KiB saved-state limit. Remove slides or split the service.");
      return;
    }
    commitState(next);
    setSectionChoice(slides[0]?.section ?? names.at(-1) ?? null);
    setComposer(null);
    setImported(null);
    setImportText("");
    setError("");
    setNotice(`Added ${slides.length} ${slides.length === 1 ? "slide" : "slides"} to the service.`);
  }
  function download(itemOnly = false) {
    const value = itemOnly ? { ...state, serviceTitle: section, sections: [section], slides: sectionSlides } : state;
    const blob = new Blob([exportChurchService(value)], { type: "application/json" });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `${value.serviceTitle.replace(/[^a-z0-9_-]/gi, "-") || "service"}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Saved service text and styling. Image files stay in your media library.");
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > MAX_SERVICE_FILE_BYTES) throw new Error("Choose a file 2 MiB or smaller.");
      const source = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        setImported(importChurchService(source));
        setImportText("");
      } else {
        setImported(null);
        setImportText(source);
      }
      setComposer("song");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this file.");
    }
  }

  return (
    <div ref={root} className="church-workspace" role="group" aria-label="Service workspace">
      <div className="church-live-bar">
        <div className="church-output-state" role="status">
          <span className={`church-signal ${isLive && !state.blackout ? "live" : ""}`} />
          <strong>{state.blackout ? "Blackout" : isLive ? "Live" : "Ready"}</strong>
          <span>
            {isLive ? onAir?.title : "Select a slide to begin"}
            {state.textCleared ? " · Text cleared" : ""}
          </span>
        </div>
        <div className="control-row">
          <button type="button" className="button" aria-label="Previous live slide" disabled={disabled || liveIndex <= 0} onClick={() => step(-1)}>
            <ArrowLeft size={16} />
          </button>
          <button type="button" className="button primary" disabled={disabled || !selected || liveMatches} onClick={() => show()}>
            Show slide
          </button>
          <button type="button" className="button" disabled={disabled || liveIndex >= ordered.length - 1} onClick={() => step(1)}>
            Next <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={Boolean(state.textCleared)}
            disabled={disabled || !isLive}
            onClick={() => commitDraft({ textCleared: !state.textCleared })}
          >
            {state.textCleared ? "Restore text" : "Clear text"}
          </button>
          <button
            type="button"
            className={`button ${state.blackout ? "danger" : ""}`}
            aria-pressed={Boolean(state.blackout)}
            disabled={disabled}
            onClick={() => commitDraft({ blackout: !state.blackout })}
          >
            {state.blackout ? "Restore screen" : "Blackout"}
          </button>
          <button
            type="button"
            className="button"
            disabled={disabled || !isLive}
            onClick={() => commitDraft({ elements: { ...state.elements, fullscreenSlide: { ...state.elements.fullscreenSlide, visible: false } } })}
          >
            Hide slide
          </button>
        </div>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
          <button className="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="church-notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      ) : null}
      <div className="church-desk">
        <aside className="church-monitors" aria-label="Preview and output controls">
          <div className="church-heading">
            <h2>Preview</h2>
            <span>Ready to show</span>
          </div>
          <div className="church-monitor" role="group" aria-label="Selected slide preview">
            {selected ? <ChurchSlideContent slide={selected} font={state.style.font} /> : <span>No slide selected</span>}
          </div>
          <div className="church-heading">
            <h2>Live output</h2>
            <span className={isLive && !state.blackout ? "church-live-label" : ""}>{state.blackout ? "Blackout" : isLive ? "On air" : "Off air"}</span>
          </div>
          <div className="church-monitor church-program" role="group" aria-label="Live output preview">
            {outputUrl ? (
              <iframe title="Church live output" src={`${outputUrl}?client=preview&display=projector`} />
            ) : isLive && onAir && !state.blackout ? (
              <ChurchSlideContent slide={onAir} hideText={state.textCleared} font={state.style.font} />
            ) : (
              <span>{state.blackout ? "Blackout" : "Screen clear"}</span>
            )}
          </div>
          {outputUrl ? (
            <div className="church-output-links">
              <a className="button" href={`${outputUrl}?display=projector`} target="_blank" rel="noreferrer">
                Open projector
              </a>
              <p>Use Stage display above for the private stage link. Move windows to their displays; press F for fullscreen.</p>
            </div>
          ) : null}
          <details className="church-service-tools" open>
            <summary>Countdown & lower third</summary>
            {cues}
          </details>
          <details className="church-service-tools">
            <summary>Stage message</summary>
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                commitDraft({ stageMessage: stageDraft.trim() });
              }}
            >
              <label className="field">
                <span>Message to stage</span>
                <textarea maxLength={500} value={stageDraft} onChange={(event) => setStageDraft(event.target.value)} />
              </label>
              <div className="control-row">
                <button type="submit" className="button" disabled={disabled}>
                  Send to stage
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={disabled || !state.stageMessage}
                  onClick={() => {
                    setStageDraft("");
                    commitDraft({ stageMessage: "" });
                  }}
                >
                  Clear message
                </button>
              </div>
            </form>
          </details>
        </aside>
        <aside className="church-rundown" aria-label="Service planning">
          <div className="church-heading">
            <h2>Service order</h2>
            <span>{sections.length} items</span>
          </div>
          <div className="church-add-row">
            <button
              type="button"
              className="button"
              onClick={() => {
                setImported(null);
                setImportText("");
                setComposer("song");
              }}
            >
              <Plus size={16} /> Add item
            </button>
            <button type="button" className="button" aria-label="Import service or lyrics" onClick={() => fileInput.current?.click()}>
              <Upload size={16} />
            </button>
            <button type="button" className="button" aria-label="Export service" onClick={() => download()}>
              <Download size={16} />
            </button>
          </div>
          <input
            ref={fileInput}
            className="visually-hidden"
            tabIndex={-1}
            type="file"
            accept=".txt,.json,text/plain,application/json"
            aria-label="Service file"
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <nav aria-label="Service order">
            {sections.map((item, index) => {
              const slides = state.slides.filter((slide) => slide.section === item);
              return (
                <button
                  type="button"
                  key={item}
                  className={`church-service-item ${section === item ? "selected" : ""}`}
                  aria-current={section === item ? "true" : undefined}
                  onClick={() => {
                    setSectionChoice(item);
                    setSearch("");
                    commitDraft({ selectedSlideId: slides[0]?.id });
                  }}
                >
                  <span className="church-item-number">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{item || "Untitled item"}</strong>
                    <small>
                      {slides.length} {slides.length === 1 ? "slide" : "slides"}
                    </small>
                  </span>
                  {isLive && slides.some((slide) => slide.id === onAir?.id) ? <span className="church-signal live" role="img" aria-label="On air" /> : null}
                </button>
              );
            })}
          </nav>
          <div className="church-rundown-foot">
            <button type="button" className="button" aria-label="Move item up" disabled={sections.indexOf(section) <= 0} onClick={() => moveSection(-1)}>
              <ArrowUp size={15} />
            </button>
            <button
              type="button"
              className="button"
              aria-label="Move item down"
              disabled={sections.indexOf(section) >= sections.length - 1}
              onClick={() => moveSection(1)}
            >
              <ArrowDown size={15} />
            </button>
            <span>Reorder selected item</span>
          </div>
          <details className="church-help">
            <summary>Running a service</summary>
            <p>Select a thumbnail to preview. Show slide sends it live. Next follows the service order.</p>
            <p>
              <kbd>Enter</kbd> Show · <kbd>Space</kbd> / <kbd>→</kbd> Next · <kbd>←</kbd> Previous · <kbd>B</kbd> Blackout · <kbd>T</kbd> Clear text. Shortcuts
              pause while typing or using controls.
            </p>
            <p>Duplicate a service from Service actions for next week. Import .txt lyrics or an exported .json service to reuse items.</p>
          </details>
        </aside>
        <section className="church-slide-workbench">
          <div className="church-heading">
            <h2>{section}</h2>
            <div className="control-row">
              <button type="button" className="button" onClick={() => addSlide("text")}>
                <Plus size={15} /> Text
              </button>
              <button type="button" className="button" onClick={() => addSlide("image")}>
                <Image size={15} /> Image
              </button>
            </div>
          </div>
          <div className="church-item-toolbar">
            <input type="search" aria-label="Find a slide" placeholder="Find a slide…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <details className="church-item-options">
              <summary>Item settings</summary>
              <div className="form-grid">
                <label className="field" key={section}>
                  <span>Item title</span>
                  <input
                    maxLength={200}
                    defaultValue={section}
                    onBlur={(event) => {
                      renameSection(event.target.value);
                      event.target.value = section;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
                <button type="button" className="button" onClick={() => append({ sections: [section], slides: sectionSlides })}>
                  <Copy size={15} /> Duplicate item
                </button>
                <button type="button" className="button" onClick={() => download(true)}>
                  <Download size={15} /> Save item for reuse
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={hasLiveItem}
                  onClick={() => {
                    const slides = state.slides.filter((slide) => slide.section !== section);
                    commitDraft({ sections: sections.filter((item) => item !== section), slides, selectedSlideId: slides[0]?.id });
                    setSectionChoice(null);
                  }}
                >
                  <Trash2 size={15} /> Delete item
                </button>
              </div>
            </details>
          </div>
          <div className="church-slide-grid slide-list" role="group" aria-label="Slides">
            {sectionSlides
              .filter((slide) => `${slide.title} ${slide.text} ${slide.label ?? ""}`.toLowerCase().includes(search.toLowerCase()))
              .map((slide) => (
                <button
                  type="button"
                  key={slide.id}
                  className={`church-thumbnail ${selected?.id === slide.id ? "selected" : ""} ${isLive && onAir?.id === slide.id ? "on-air" : ""}`}
                  aria-label={`Preview ${slide.title}, slide ${ordered.indexOf(slide) + 1} of ${ordered.length}${isLive && onAir?.id === slide.id ? ", on air" : ""}`}
                  aria-pressed={selected?.id === slide.id}
                  onClick={() => select(slide)}
                >
                  <div className="church-thumbnail-picture">
                    <ChurchSlideContent slide={slide} font={state.style.font} motion={false} />
                  </div>
                  <span className="church-thumbnail-caption">
                    <span>
                      {ordered.indexOf(slide) + 1}. {slide.label || slide.title}
                    </span>
                    {isLive && onAir?.id === slide.id ? <strong>LIVE</strong> : null}
                  </span>
                </button>
              ))}
          </div>
          {!sectionSlides.length ? (
            <div className="church-empty">
              <Presentation size={28} />
              <h3>No slides in this item</h3>
              <p>Add text or an image, or paste a song or reading.</p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setImported(null);
                  setImportText("");
                  setComposer("scripture");
                }}
              >
                Add a reading
              </button>
            </div>
          ) : null}
          {search && !sectionSlides.some((slide) => `${slide.title} ${slide.text} ${slide.label ?? ""}`.toLowerCase().includes(search.toLowerCase())) ? (
            <p className="muted">No matching slides.</p>
          ) : null}
          {selected && selected.section === section ? (
            <details className="church-slide-editor" open={editing} onToggle={(event) => setEditing(event.currentTarget.open)}>
              <summary>
                Edit slide <span>{selected.title}</span>
              </summary>
              <div className="form-grid">
                <div className="two-col">
                  <label className="field">
                    <span>Title</span>
                    <input maxLength={200} value={selected.title} onChange={(event) => updateSlide({ title: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Group label</span>
                    <input
                      maxLength={80}
                      placeholder="Verse 1, Chorus…"
                      value={selected.label ?? ""}
                      onChange={(event) => updateSlide({ label: event.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Text</span>
                  <textarea rows={5} maxLength={10000} value={selected.text} onChange={(event) => updateSlide({ text: event.target.value })} />
                </label>
                <label className="field">
                  <span>Reference / copyright</span>
                  <input maxLength={300} value={selected.reference ?? ""} onChange={(event) => updateSlide({ reference: event.target.value })} />
                </label>
                <ChurchBackgroundPicker
                  value={selected.backgroundPreset ?? "solid"}
                  motion={selected.backgroundMotion !== false}
                  onChange={(backgroundPreset) =>
                    updateSlide({
                      backgroundPreset,
                      backgroundDim: selected.backgroundPreset && selected.backgroundPreset !== "solid" ? selected.backgroundDim : 10,
                      backgroundMotion: selected.backgroundMotion ?? true,
                      mediaId: undefined,
                      mediaUrl: undefined,
                      type: "text"
                    })
                  }
                  onMotionChange={(backgroundMotion) => updateSlide({ backgroundMotion })}
                />
                <div className="two-col">
                  <div className="field">
                    <MediaPicker
                      label="Image/background"
                      selectedId={selected.mediaId}
                      initialItems={availableMedia}
                      onSelect={(item) => updateSlide({ mediaId: item?.id, mediaUrl: item?.url, type: item ? "image" : "text", backgroundPreset: "solid" })}
                    />
                  </div>
                  <label className="field">
                    <span>Background dimming</span>
                    <input
                      type="range"
                      min={0}
                      max={90}
                      value={selected.backgroundDim ?? 0}
                      onChange={(event) => updateSlide({ backgroundDim: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <label className="button church-image-upload" aria-disabled={uploading || disabled}>
                  <Upload size={15} /> {uploading ? "Uploading image…" : "Upload image"}
                  <input
                    className="visually-hidden"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    aria-label="Upload slide image"
                    disabled={uploading || disabled}
                    onChange={(event) => {
                      void uploadImage(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <div className="church-format-row">
                  <label className="field">
                    <span>Background</span>
                    <input type="color" value={selected.backgroundColor} onChange={(event) => updateSlide({ backgroundColor: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Text color</span>
                    <input type="color" value={selected.textColor} onChange={(event) => updateSlide({ textColor: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Text size</span>
                    <select value={selected.fontSize ?? 86} onChange={(event) => updateSlide({ fontSize: Number(event.target.value) })}>
                      {[48, 60, 76, 86, 100, 120, ...(![48, 60, 76, 86, 100, 120].includes(selected.fontSize ?? 86) ? [selected.fontSize!] : [])].map(
                        (size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        )
                      )}
                    </select>
                  </label>
                  <label className="field">
                    <span>Alignment</span>
                    <select
                      value={selected.textAlign ?? "center"}
                      onChange={(event) => updateSlide({ textAlign: event.target.value as ChurchSlide["textAlign"] })}
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const { backgroundColor, textColor, fontSize, textAlign, backgroundDim, backgroundPreset, backgroundMotion, mediaId, mediaUrl } = selected;
                    commitDraft({
                      slides: state.slides.map((slide) =>
                        slide.section === section
                          ? {
                              ...slide,
                              backgroundColor,
                              textColor,
                              fontSize,
                              textAlign,
                              backgroundDim,
                              backgroundPreset,
                              backgroundMotion,
                              mediaId,
                              mediaUrl,
                              type: mediaUrl ? "image" : "text"
                            }
                          : slide
                      )
                    });
                    setNotice("Appearance applied to this item. Live output stays unchanged until Show slide.");
                  }}
                >
                  Apply appearance to this item
                </button>
                <label className="field">
                  <span>Stage notes</span>
                  <textarea
                    rows={2}
                    maxLength={2000}
                    placeholder="Shown on the stage screen"
                    value={selected.notes ?? ""}
                    onChange={(event) => updateSlide({ notes: event.target.value })}
                  />
                </label>
                <div className="control-row">
                  <button
                    type="button"
                    className="button"
                    aria-label="Move slide up"
                    disabled={sectionSlides[0]?.id === selected.id}
                    onClick={() => moveSlide(-1)}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-label="Move slide down"
                    disabled={sectionSlides.at(-1)?.id === selected.id}
                    onClick={() => moveSlide(1)}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={state.slides.length >= 500}
                    onClick={() => {
                      const copy = { ...selected, id: makeId("slide"), title: `${selected.title} copy`.slice(0, 200) };
                      const slides = [...state.slides];
                      slides.splice(slides.findIndex((slide) => slide.id === selected.id) + 1, 0, copy);
                      commitDraft({ slides, selectedSlideId: copy.id });
                    }}
                  >
                    Duplicate slide
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={isLive && onAir?.id === selected.id}
                    onClick={() => {
                      const slides = state.slides.filter((slide) => slide.id !== selected.id);
                      commitDraft({ slides, selectedSlideId: slides.find((slide) => slide.section === section)?.id ?? slides[0]?.id });
                    }}
                  >
                    Delete slide
                  </button>
                </div>
              </div>
            </details>
          ) : null}
        </section>
      </div>
      {composer ? (
        <ServiceComposer
          kind={composer}
          initialText={importText}
          imported={imported}
          maxSlides={500 - state.slides.length}
          maxItems={100 - sections.length}
          onClose={() => {
            setComposer(null);
            setImported(null);
          }}
          onAdd={append}
        />
      ) : null}
    </div>
  );
}

function ServiceComposer({
  kind,
  initialText,
  imported,
  onClose,
  onAdd,
  maxSlides,
  maxItems
}: {
  kind: ItemKind;
  initialText: string;
  imported: ReturnType<typeof importChurchService> | null;
  maxSlides: number;
  maxItems: number;
  onClose: () => void;
  onAdd: (content: ReturnType<typeof importChurchService>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState(kind);
  const [title, setTitle] = useState("");
  const [text, setText] = useState(initialText);
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState(4);
  const [backgroundPreset, setBackgroundPreset] = useState<ChurchBackgroundPreset>("solid");
  const [backgroundMotion, setBackgroundMotion] = useState(true);
  const prepared = useMemo(() => {
    try {
      return {
        slides:
          imported?.slides ??
          prepareChurchSlides(text, title.trim() || "Untitled", lines, reference).map((slide) => ({
            ...slide,
            backgroundPreset,
            backgroundMotion,
            backgroundDim: backgroundPreset === "solid" ? slide.backgroundDim : 10
          })),
        error: ""
      };
    } catch (err) {
      return { slides: [], error: err instanceof Error ? err.message : "Could not prepare slides." };
    }
  }, [imported, text, title, lines, reference, backgroundPreset, backgroundMotion]);
  const capacityError =
    prepared.slides.length > maxSlides || (imported?.sections.length ?? 1) > maxItems
      ? `This service has room for ${maxItems} more items and ${maxSlides} more slides.`
      : "";
  const preparationError = prepared.error || capacityError;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="church-composer"
      aria-labelledby="church-composer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (prepared.slides.length && !preparationError) onAdd(imported ?? { sections: [title.trim()], slides: prepared.slides });
        }}
      >
        <div className="church-heading">
          <h2 id="church-composer-title">{imported ? "Import service" : "Add to service"}</h2>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
        {imported ? (
          <p>
            {imported.sections.length} service items · {imported.slides.length} slides. Added after your existing items.
          </p>
        ) : (
          <>
            <div className="church-composer-types" role="group" aria-label="Item type">
              {(
                [
                  ["song", Music2, "Song"],
                  ["scripture", BookOpen, "Scripture"],
                  ["announcement", Presentation, "Announcement"]
                ] as const
              ).map(([value, Icon, label]) => (
                <button type="button" key={value} className="button" aria-pressed={type === value} onClick={() => setType(value)}>
                  <Icon size={17} />
                  {label}
                </button>
              ))}
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Item title</span>
                <input
                  autoFocus
                  required
                  maxLength={200}
                  placeholder={type === "song" ? "Song title" : type === "scripture" ? "Reading or passage" : "Announcement title"}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{type === "song" ? "Lyrics" : type === "scripture" ? "Scripture text" : "Announcement text"}</span>
                <textarea
                  required
                  rows={8}
                  maxLength={100000}
                  placeholder={
                    type === "song" ? "[Verse 1]\nPaste lyrics here\n\n[Chorus]\nPaste the chorus here" : "Paste your text here. Blank lines start a new slide."
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <p className="muted">
                Blank lines separate slides. Long passages split automatically.{type === "song" ? " Use [Verse 1], [Chorus], or [Bridge] to label groups." : ""}
              </p>
              <div className="two-col">
                <label className="field">
                  <span>{type === "scripture" ? "Bible reference & translation" : "Reference / copyright"}</span>
                  <input
                    maxLength={300}
                    value={reference}
                    placeholder={type === "scripture" ? "John 3:16 · translation" : "Optional footer"}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Lines per slide</span>
                  <select value={lines} onChange={(event) => setLines(Number(event.target.value))}>
                    {[2, 3, 4, 6, 8].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </>
        )}
        {!imported ? (
          <ChurchBackgroundPicker value={backgroundPreset} motion={backgroundMotion} onChange={setBackgroundPreset} onMotionChange={setBackgroundMotion} />
        ) : null}
        {preparationError ? (
          <p className="error" role="alert">
            {preparationError}
          </p>
        ) : null}
        <div className="church-import-preview" role="group" aria-label="Import preview">
          {prepared.slides.slice(0, 12).map((slide, index) => (
            <div key={slide.id}>
              <ChurchSlideContent slide={slide} motion={false} />
              <small>
                {index + 1}. {slide.label || slide.title}
              </small>
            </div>
          ))}
        </div>
        <footer>
          <span>
            {prepared.slides.length} {prepared.slides.length === 1 ? "slide" : "slides"}
            {prepared.slides.length > 12 ? " · first 12 shown" : ""}
          </span>
          <button type="submit" className="button primary" disabled={!prepared.slides.length || Boolean(preparationError) || (!imported && !title.trim())}>
            Add {prepared.slides.length} {prepared.slides.length === 1 ? "slide" : "slides"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
