import { randomUUID } from "node:crypto";
import { request } from "@playwright/test";

export default async function globalSetup() {
  const port = Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 18734;
  const backend = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${port}`;
  const api = await request.newContext({ baseURL: backend });
  try {
    for (const suite of ["openoverlay", "navigation", "church"] as const) {
      const account = { email: `service-${suite}-${randomUUID()}@openoverlay.local`, password: `E2e-${randomUUID()}` };
      const response = await api.post("/api/v1/auth/signup", {
        headers: { "X-OpenOverlay-Api-Version": "v1" },
        data: account
      });
      if (response.status() !== 201) throw new Error(`E2E ${suite} account setup failed: HTTP ${response.status()}`);
      process.env[`OPENOVERLAY_E2E_${suite.toUpperCase()}_EMAIL`] = account.email;
      process.env[`OPENOVERLAY_E2E_${suite.toUpperCase()}_PASSWORD`] = account.password;
    }
  } finally {
    await api.dispose();
  }
}
