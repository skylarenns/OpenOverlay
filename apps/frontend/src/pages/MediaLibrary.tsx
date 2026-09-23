import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { announceMediaUpload, MediaThumbnail } from "../components/MediaPicker";
import { PageSkeleton } from "../components/PageSkeleton";
import { mediaApi, type MediaItem } from "../lib/api";

export function MediaLibrary() {
  const [loading, setLoading] = useState(true);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const uploadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const mediaMutationsRef = useRef(new Set<string>());
  const loadGenerationRef = useRef(0);
  const componentAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal, failureMessage = "Could not load media") => {
    const generation = ++loadGenerationRef.current;
    setError(null);
    try {
      const response = await mediaApi.list(signal);
      if (!signal?.aborted && loadGenerationRef.current === generation) {
        setMedia(response.media);
        setNextCursor(response.nextCursor);
      }
    } catch (err) {
      if (!signal?.aborted && loadGenerationRef.current === generation) {
        setError(`${failureMessage}${err instanceof Error ? `: ${err.message}` : "."}`);
      }
    } finally {
      if (!signal?.aborted && loadGenerationRef.current === generation) setLoading(false);
    }
  }, []);

  async function loadMore() {
    const controller = componentAbortRef.current;
    if (!controller || controller.signal.aborted || !nextCursor || loadingMoreRef.current) return;
    const generation = loadGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await mediaApi.list(controller.signal, nextCursor);
      if (!controller.signal.aborted && generation === loadGenerationRef.current) {
        setMedia((current) => [...current, ...response.media.filter((item) => !current.some((existing) => existing.id === item.id))]);
        setNextCursor(response.nextCursor);
      }
    } catch (err) {
      if (!controller.signal.aborted && generation === loadGenerationRef.current) setError(err instanceof Error ? err.message : "Could not load more media");
    } finally {
      loadingMoreRef.current = false;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    componentAbortRef.current = controller;
    void load(controller.signal);
    return () => {
      controller.abort();
      if (componentAbortRef.current === controller) componentAbortRef.current = null;
    };
  }, [load]);

  async function uploadFiles(files: FileList | File[]) {
    if (uploadingRef.current) return;
    setError(null);
    const selectedFiles = Array.from(files);
    if (selectedFiles.length === 0) return;
    if (selectedFiles.length > 20) {
      setError("Choose at most 20 files per upload batch.");
      return;
    }
    const controller = componentAbortRef.current;
    if (!controller || controller.signal.aborted) return;
    uploadingRef.current = true;
    setUploading(true);
    try {
      const results: PromiseSettledResult<{ media: MediaItem }>[] = [];
      for (let index = 0; index < selectedFiles.length && !controller.signal.aborted; index += 2) {
        const batch = await Promise.allSettled(selectedFiles.slice(index, index + 2).map((file) => mediaApi.upload(file, controller.signal)));
        results.push(...batch);
        if (controller.signal.aborted) return;
        const uploaded = batch.flatMap((result) => (result.status === "fulfilled" ? [result.value.media] : []));
        if (uploaded.length > 0) {
          ++loadGenerationRef.current;
          setMedia((current) => [...uploaded, ...current.filter((item) => !uploaded.some((added) => added.id === item.id))]);
          uploaded.forEach(announceMediaUpload);
        }
      }
      if (controller.signal.aborted) return;
      await load(controller.signal, "Uploads finished, but the media library could not be refreshed");
      if (controller.signal.aborted) return;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) setError(`${failures.length} of ${selectedFiles.length} uploads failed. Successful uploads were kept.`);
    } finally {
      uploadingRef.current = false;
      if (!controller.signal.aborted) setUploading(false);
    }
  }

  async function remove(id: string) {
    if (mediaMutationsRef.current.has(id)) return;
    if (!window.confirm("Delete this media item? Existing graphics that use it may lose their image.")) return;
    const controller = componentAbortRef.current;
    if (!controller || controller.signal.aborted) return;
    mediaMutationsRef.current.add(id);
    setDeletingIds((current) => new Set(current).add(id));
    setError(null);
    try {
      await mediaApi.remove(id, controller.signal);
      if (controller.signal.aborted) return;
      ++loadGenerationRef.current;
      setMedia((current) => current.filter((item) => item.id !== id));
      await load(controller.signal, "Media deleted, but the library could not be refreshed");
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not delete media");
    } finally {
      mediaMutationsRef.current.delete(id);
      if (!controller.signal.aborted) {
        setDeletingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Media</h1>
        </div>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}{" "}
          <button
            className="button"
            type="button"
            onClick={() => {
              setLoading(true);
              void load(componentAbortRef.current?.signal);
            }}
          >
            Retry media
          </button>
        </div>
      ) : null}
      <label
        className={`dropzone ${uploading ? "disabled" : ""}`}
        aria-disabled={uploading}
        onDragOver={(event) => {
          if (!uploadingRef.current) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (uploadingRef.current) return;
          void uploadFiles(event.dataTransfer.files);
        }}
      >
        <Upload size={28} />
        <strong>{uploading ? "Uploading images..." : "Drop images here"}</strong>
        <span className="muted">{uploading ? "Wait for this batch to finish" : "PNG, JPG, SVG, or WebP"}</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          multiple
          disabled={uploading}
          className="visually-hidden-file-input"
          aria-label="Upload media files"
          onChange={(event) => {
            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
            event.currentTarget.value = "";
            if (files.length > 0) void uploadFiles(files);
          }}
        />
      </label>
      {loading ? <PageSkeleton variant="media" contentOnly /> : null}
      <section className="media-grid" style={{ marginTop: loading ? 0 : 18 }}>
        {media.map((item) => (
          <article className="media-card" key={item.id}>
            <div className="media-thumb">
              <MediaThumbnail item={item} />
            </div>
            <footer>
              <strong title={item.originalFilename}>{item.originalFilename}</strong>
              {item.width && item.height ? (
                <span className="muted">
                  {item.width} × {item.height}
                </span>
              ) : null}
              <button className="button danger" type="button" disabled={deletingIds.has(item.id)} onClick={() => void remove(item.id)}>
                <Trash2 size={16} /> {deletingIds.has(item.id) ? "Deleting..." : "Delete"}
              </button>
            </footer>
          </article>
        ))}
      </section>
      {nextCursor ? (
        <button className="button" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}
