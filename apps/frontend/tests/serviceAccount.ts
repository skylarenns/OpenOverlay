export function serviceAccount(suite: "openoverlay" | "navigation" | "church") {
  const email = process.env[`OPENOVERLAY_E2E_${suite.toUpperCase()}_EMAIL`];
  const password = process.env[`OPENOVERLAY_E2E_${suite.toUpperCase()}_PASSWORD`];
  if (!email || !password) throw new Error(`Playwright global setup did not provision the ${suite} account`);
  return { email, password };
}
