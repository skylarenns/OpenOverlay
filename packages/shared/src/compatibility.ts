export const OPENOVERLAY_API_VERSION = "v1";
export const OPENOVERLAY_REALTIME_VERSION = "v1";
export const OPENOVERLAY_SUPPORTED_API_VERSIONS = [OPENOVERLAY_API_VERSION] as const;
export const OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS = [OPENOVERLAY_REALTIME_VERSION] as const;

export interface OpenOverlayCompatibility {
  features?: { stage: boolean; mutationReceipts?: boolean };
  api: {
    current: typeof OPENOVERLAY_API_VERSION;
    supported: readonly string[];
    unversionedAlias: typeof OPENOVERLAY_API_VERSION;
  };
  realtime: {
    current: typeof OPENOVERLAY_REALTIME_VERSION;
    supported: readonly string[];
  };
}

export function openOverlayCompatibility(): OpenOverlayCompatibility {
  return {
    features: { stage: true, mutationReceipts: true },
    api: {
      current: OPENOVERLAY_API_VERSION,
      supported: OPENOVERLAY_SUPPORTED_API_VERSIONS,
      unversionedAlias: OPENOVERLAY_API_VERSION
    },
    realtime: {
      current: OPENOVERLAY_REALTIME_VERSION,
      supported: OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS
    }
  };
}
