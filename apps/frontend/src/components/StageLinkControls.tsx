import { useEffect, useState } from "react";
import { CopyButton } from "./Controls";
import { AUTH_EXPIRED_EVENT, stageApi, statusApi } from "../lib/api";

export function StageLinkControls({ presetId, publicId, onError }: { presetId: string; publicId: string; onError: (error: string | null) => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const clear = () => setKey(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, clear);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, clear);
  }, []);
  useEffect(() => {
    let active = true;
    setKey(null);
    setSupported(null);
    void statusApi
      .health()
      .then((health) => {
        if (!active) return null;
        const available = health.compatibility?.features?.stage === true;
        setSupported(available);
        return available ? stageApi.getKey(presetId) : null;
      })
      .then((result) => {
        if (active && result?.publicId === publicId) setKey(result.stageKey);
      })
      .catch((error: unknown) => {
        if (active) onError(error instanceof Error ? error.message : "Could not load stage link");
      });
    return () => {
      active = false;
    };
  }, [presetId, publicId, onError]);

  async function change(rotate: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (rotate) {
        const result = await stageApi.rotate(presetId);
        setKey(result.stageKey);
      } else {
        await stageApi.revoke(presetId);
        setKey(null);
      }
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update stage access");
    } finally {
      setBusy(false);
    }
  }

  const url = key ? `${window.location.origin}/overlay/${publicId}?display=stage#${key}` : null;
  if (supported === false) return <p className="muted">Stage display requires a backend with stage access support.</p>;
  return (
    <div className="control-row" aria-label="Stage access">
      <span>Stage display</span>
      {url ? (
        <>
          <a className="button" href={url} target="_blank" rel="noreferrer">
            Open stage screen
          </a>
          <CopyButton value={url} onError={onError} />
        </>
      ) : (
        <span>{supported === null ? "Loading stage access…" : "Access revoked"}</span>
      )}
      <button className="button" type="button" disabled={busy || supported !== true} onClick={() => void change(true)}>
        {key ? "Rotate stage link" : "Create stage link"}
      </button>
      {key ? (
        <button className="button" type="button" disabled={busy} onClick={() => void change(false)}>
          Revoke stage link
        </button>
      ) : null}
    </div>
  );
}
