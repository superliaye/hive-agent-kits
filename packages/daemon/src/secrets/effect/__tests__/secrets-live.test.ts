import { describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { SECRETS_FILE_VERSION, type SecretsFile } from "../../types.ts";
import { SecretsNoCredentials, SecretsRefreshTarget } from "../errors.ts";
import { Secrets, SecretsLive } from "../secrets-live.ts";

const FUTURE = 9_000_000_000_000;

function svcWith(initial?: SecretsFile) {
  const rt = ManagedRuntime.make(SecretsLive({ mode: "memory", initial }));
  return { svc: rt.runSync(Secrets), rt };
}

const oauthSeed: SecretsFile = {
  version: SECRETS_FILE_VERSION,
  secrets: {
    anthropic: {
      kind: "oauth",
      credentials: { access: "a", refresh: "r", expires: FUTURE },
      addedAt: 0,
    },
  },
};

describe("SecretsLive — effect surface", () => {
  test("requireAuth fails with SecretsNoCredentials for a missing provider; getAuth stays undefined", async () => {
    const { svc, rt } = svcWith();
    const failure = await Effect.runPromise(Effect.flip(svc.requireAuth("anthropic")));
    expect(failure).toBeInstanceOf(SecretsNoCredentials);
    expect(failure.provider).toBe("anthropic");
    expect(await svc.getAuth("anthropic")).toBeUndefined();
    rt.dispose();
  });

  test("requireAuth succeeds for a configured provider", async () => {
    const { svc, rt } = svcWith(oauthSeed);
    const auth = await Effect.runPromise(svc.requireAuth("anthropic"));
    expect(auth.kind).toBe("oauth");
    rt.dispose();
  });

  test("refresh yields typed SecretsRefreshTarget for missing / non-oauth, and persists for oauth", async () => {
    const { svc, rt } = svcWith({
      version: SECRETS_FILE_VERSION,
      secrets: {
        openai: { kind: "apiKey", apiKey: "sk", addedAt: 0 },
        anthropic: {
          kind: "oauth",
          credentials: { access: "a", refresh: "r", expires: FUTURE },
          addedAt: 0,
        },
      },
    });
    const missing = await Effect.runPromise(
      Effect.flip(svc.refresh("nope", { access: "x", refresh: "y", expires: FUTURE })),
    );
    expect(missing).toBeInstanceOf(SecretsRefreshTarget);
    expect(missing.reason).toBe("missing");

    const notOauth = await Effect.runPromise(
      Effect.flip(svc.refresh("openai", { access: "x", refresh: "y", expires: FUTURE })),
    );
    expect(notOauth.reason).toBe("not-oauth");

    await Effect.runPromise(
      svc.refresh("anthropic", { access: "new", refresh: "r2", expires: FUTURE }),
    );
    const auth = await svc.getAuth("anthropic");
    expect(auth?.kind).toBe("oauth");
    if (auth?.kind === "oauth") expect(auth.credentials.access).toBe("new");
    rt.dispose();
  });

  test("the OAuth onRefresh callback persists new credentials mid-call", async () => {
    const { svc, rt } = svcWith(oauthSeed);
    const auth = await svc.getAuth("anthropic");
    expect(auth?.kind).toBe("oauth");
    if (auth?.kind === "oauth") {
      await auth.onRefresh({ access: "refreshed", refresh: "r2", expires: FUTURE });
    }
    const after = await svc.getAuth("anthropic");
    expect(after?.kind).toBe("oauth");
    if (after?.kind === "oauth") expect(after.credentials.access).toBe("refreshed");
    rt.dispose();
  });
});
