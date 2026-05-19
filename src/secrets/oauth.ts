// OAuth login orchestration. Wraps pi-ai's provider login primitives
// (`@earendil-works/pi-ai/oauth`) — Hive supplies UI callbacks (open
// browser, prompt for code, etc.) and persistence; pi-ai owns the
// PKCE / token-exchange protocol per provider.
//
// Per-request token refresh lives in the model adapter
// (`src/model-gateway/adapters/pi-ai.ts`) because the refresh→apiKey
// translation is pi-ai-API-specific. The Secrets module deals only with
// credential storage + initial login.

import { type OAuthLoginCallbacks, getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { type OAuthCredentials, OAuthCredentialsSchema } from "./types.ts";

/**
 * Drive an OAuth login flow for a provider via pi-ai's protocol
 * implementation. Returns the validated credentials. Persistence is the
 * caller's responsibility (typically `store.set(provider, entry)` in the
 * Secrets index).
 *
 * Throws if the provider is not registered in pi-ai's OAuth registry.
 */
export async function loginOAuth(
  provider: string,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const piProvider = getOAuthProvider(provider);
  if (!piProvider) {
    throw new Error(`secrets/oauth: unknown OAuth provider "${provider}"`);
  }
  const credentials = await piProvider.login(callbacks);
  return OAuthCredentialsSchema.parse(credentials);
}
