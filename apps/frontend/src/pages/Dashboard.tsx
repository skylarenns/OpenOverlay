import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { type PresetListItem, type PresetType } from "@openoverlay/shared";
import { ActionMenu, CopyButton } from "../components/Controls";
import { ModalLayer } from "../components/ModalLayer";
import { PageSkeleton } from "../components/PageSkeleton";
import { presetApi, statusApi, type BackupStatus } from "../lib/api";
import { dispatchPresetDeleted } from "../lib/uiEvents";

const PRESET_NAME_PLACEHOLDERS: Record<PresetType, string> = {
  soccer: "Soccer Game",
  church: "Church Sunday",
  custom: "Custom"
};

export function formatOverlayClientCount(count: number): string {
  return `${count} ${count === 1 ? "output" : "outputs"}`;
}

export function Dashboard() {
  const [presets, setPresets] = useState<PresetListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isNewGameOpen, setIsNewGameOpen] = useState(false);
  const [newGameType, setNewGameType] = useState<PresetType>("soccer");
  const [newGameName, setNewGameName] = useState(PRESET_NAME_PLACEHOLDERS.soccer);
  const [creatingGame, setCreatingGame] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const creatingGameRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const navigate = useNavigate();
  const newGameNameRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const response = await presetApi.list(signal);
    if (signal?.aborted || generation !== loadGenerationRef.current) return;
    setPresets(response.presets);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void statusApi.backup(controller.signal).then(setBackupStatus, () => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      void load(controller.signal).catch((err) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(err instanceof Error ? err.message : "Could not load productions");
        }
      });
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!isNewGameOpen) return;
    const id = window.setTimeout(() => newGameNameRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isNewGameOpen]);

  function openNewGameDialog() {
    setCreateError(null);
    setNewGameType("soccer");
    setNewGameName(PRESET_NAME_PLACEHOLDERS.soccer);
    setIsNewGameOpen(true);
  }

  function closeNewGameDialog() {
    setIsNewGameOpen(false);
  }

  async function createPreset(event: React.FormEvent) {
    event.preventDefault();
    if (creatingGameRef.current) return;
    const trimmedName = newGameName.trim();
    if (!trimmedName) return;
    creatingGameRef.current = true;
    setCreatingGame(true);
    setError(null);
    try {
      const response = await presetApi.create(trimmedName, newGameType);
      setIsNewGameOpen(false);
      void navigate(`/dash/presets/${response.preset.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create production");
    } finally {
      creatingGameRef.current = false;
      setCreatingGame(false);
    }
  }

  async function manageGame(preset: PresetListItem, action: "duplicate" | "delete") {
    if (cardBusy) return;
    if (action === "delete" && !window.confirm(`Delete “${preset.name}”? Its output URL will stop working.`)) return;
    setCardBusy(preset.id);
    try {
      if (action === "duplicate") {
        const result = await presetApi.duplicate(preset.id);
        void navigate(`/dash/presets/${result.preset.id}`);
      } else {
        await presetApi.remove(preset.id, preset.revision);
        await load();
        dispatchPresetDeleted({ id: preset.id, publicId: preset.publicId, revision: preset.revision });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update production");
    } finally {
      setCardBusy(null);
    }
  }

  if (loading) return <PageSkeleton variant="games" title="Productions" />;

  return (
    <>
      <div className="page-title">
        <h1>Productions</h1>
      </div>
      {backupStatus?.failedSinceSuccess || backupStatus?.overdue ? (
        <div className="error" role="alert">
          {backupStatus.failedSinceSuccess ? "Last scheduled backup failed." : "No recent verified backup is recorded."}
        </div>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <section className="preset-grid game-card-grid">
        <button className="preset-card preset-card-new" type="button" onClick={openNewGameDialog}>
          <span className="new-game-card-icon" aria-hidden="true">
            <Plus size={22} />
          </span>
          <span className="new-game-card-copy">
            <h2>New Production</h2>
            <p>Soccer / Church</p>
          </span>
        </button>
        {presets.map((preset) => (
          <article className="preset-card game-card" key={preset.id}>
            <div className="game-card-body">
              <div className="game-card-meta">
                <span>{preset.type === "soccer" ? "Soccer" : preset.type}</span>
                <span>{formatOverlayClientCount(preset.overlayClientCount || 0)}</span>
              </div>
              <h2>
                <Link to={`/dash/presets/${preset.id}`} aria-label={`Open ${preset.name}`}>
                  {preset.name}
                </Link>
              </h2>
              <div className="control-row game-card-actions">
                <CopyButton value={`${window.location.origin}/overlay/${preset.publicId}`} onError={setError} />
                <a className="button" href={`/overlay-test/${preset.publicId}`} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> Test output
                </a>
              </div>
            </div>
            <ActionMenu label={`${preset.name} actions`}>
              <button className="button" disabled={cardBusy === preset.id} onClick={() => void manageGame(preset, "duplicate")}>
                <Copy size={14} />
                Duplicate
              </button>
              <button className="button danger" disabled={cardBusy === preset.id} onClick={() => void manageGame(preset, "delete")}>
                <Trash2 size={14} />
                Delete
              </button>
            </ActionMenu>
          </article>
        ))}
      </section>
      {isNewGameOpen ? (
        <ModalLayer initialFocusRef={newGameNameRef} onClose={closeNewGameDialog}>
          <form className="prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="new-game-dialog-title" onSubmit={createPreset}>
            <h2 id="new-game-dialog-title">New production</h2>
            {createError ? (
              <div className="error" role="alert">
                {createError}
              </div>
            ) : null}
            <label className="field">
              <span>Production type</span>
              <select
                className="number-input"
                value={newGameType}
                disabled={creatingGame}
                onChange={(event) => {
                  const nextType = event.target.value as PresetType;
                  setNewGameType(nextType);
                  setNewGameName(PRESET_NAME_PLACEHOLDERS[nextType]);
                }}
              >
                <option value="soccer">Soccer</option>
                <option value="church">Church</option>
              </select>
            </label>
            <label className="field">
              <span>Production name</span>
              <input
                ref={newGameNameRef}
                value={newGameName}
                disabled={creatingGame}
                onChange={(event) => setNewGameName(event.target.value)}
                placeholder={PRESET_NAME_PLACEHOLDERS[newGameType]}
              />
            </label>
            <div className="control-row prompt-actions">
              <button className="button" type="button" onClick={closeNewGameDialog} disabled={creatingGame}>
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={creatingGame || !newGameName.trim()}>
                {creatingGame ? "Creating..." : "Create production"}
              </button>
            </div>
          </form>
        </ModalLayer>
      ) : null}
    </>
  );
}
