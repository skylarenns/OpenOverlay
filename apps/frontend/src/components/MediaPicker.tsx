import { useEffect, useState } from "react";
import { mediaApi, type MediaItem } from "../lib/api";

export const MEDIA_UPLOADED_EVENT = "openoverlay:media-uploaded";

export function announceMediaUpload(item: MediaItem): void {
  window.dispatchEvent(new CustomEvent<MediaItem>(MEDIA_UPLOADED_EVENT, { detail: item }));
}

export function mergeMediaItems(current: MediaItem[], added: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const merged = [...current, ...added].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return merged.length === current.length && merged.every((item, index) => item === current[index]) ? current : merged;
}

export function MediaThumbnail({ item }: { item: MediaItem }) {
  const [source, setSource] = useState(item.thumbnailUrl || item.url);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSource(item.thumbnailUrl || item.url);
    setFailed(false);
  }, [item.thumbnailUrl, item.url]);
  if (failed) return <span className="media-image-unavailable">Image unavailable</span>;
  return (
    <img
      src={mediaApi.mediaUrl(source)}
      alt=""
      loading="lazy"
      onError={() => {
        if (source !== item.url) setSource(item.url);
        else setFailed(true);
      }}
    />
  );
}

export function MediaPicker({
  label,
  selectedId,
  initialItems,
  onSelect
}: {
  label: string;
  selectedId?: string;
  initialItems: MediaItem[];
  onSelect: (item: MediaItem | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedFirst, setLoadedFirst] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setItems((current) => mergeMediaItems(current, initialItems)), [initialItems]);
  useEffect(() => {
    const uploaded = (event: Event) => setItems((current) => mergeMediaItems(current, [(event as CustomEvent<MediaItem>).detail]));
    window.addEventListener(MEDIA_UPLOADED_EVENT, uploaded);
    return () => window.removeEventListener(MEDIA_UPLOADED_EVENT, uploaded);
  }, []);

  async function loadPage(next: string | null) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await mediaApi.list(undefined, next ?? undefined);
      setItems((current) => mergeMediaItems(current, response.media));
      setCursor(response.nextCursor);
      setLoadedFirst(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load media");
    } finally {
      setLoading(false);
    }
  }

  const selected = items.find((item) => item.id === selectedId);
  return (
    <div className="media-picker">
      <button
        type="button"
        className="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          if (!open && !loadedFirst) void loadPage(null);
        }}
      >
        {label}: {selected?.originalFilename ?? (selectedId ? "Current image" : "None")}
      </button>
      {open ? (
        <div className="media-picker-panel" role="region" aria-label={`${label} media library`}>
          <button
            className="button"
            type="button"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            No image
          </button>
          {loading && !loadedFirst ? <p role="status">Loading media…</p> : null}
          {!loading && loadedFirst && !items.length ? <p>No images uploaded.</p> : null}
          <div className="media-picker-grid">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="media-picker-item"
                aria-label={item.originalFilename}
                aria-pressed={item.id === selectedId}
                onClick={() => {
                  onSelect(item);
                  setOpen(false);
                }}
              >
                <MediaThumbnail item={item} />
                <span title={item.originalFilename}>{item.originalFilename}</span>
              </button>
            ))}
          </div>
          {error ? (
            <div role="alert">
              {error}{" "}
              <button className="button" type="button" onClick={() => void loadPage(loadedFirst ? cursor : null)}>
                Retry media
              </button>
            </div>
          ) : null}
          {cursor ? (
            <button className="button" type="button" disabled={loading} onClick={() => void loadPage(cursor)}>
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
