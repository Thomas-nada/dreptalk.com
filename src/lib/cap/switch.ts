/**
 * The one deploy switch for the CAP portal mirror: CAP_PORTAL_URL presence.
 * Where it is unset the `caps` category does not exist (absent from the sidebar,
 * the home page and the sitemap, and /c/caps/ is a 404) and the gov-sync mirror
 * phase is gated out, exactly as TESSERA_BACKEND_URL gates CIP-179 surveys.
 * A single source of truth so the app and the cron worker can never disagree on
 * whether CAP is on.
 */
export function capsEnabled(env: Pick<Cloudflare.Env, 'CAP_PORTAL_URL'>): boolean {
  return Boolean(env.CAP_PORTAL_URL);
}
