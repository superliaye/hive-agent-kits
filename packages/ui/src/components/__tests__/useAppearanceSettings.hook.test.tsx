// Hook-level coverage for useAppearanceSettings that needs a React tree:
//   - the displayed accent tracks the applied OS accent when system-accent is
//     locked, and falls back to the per-mode override when it's off;
//   - resetOverrides() clears the per-mode config and undoReset() restores the
//     exact pre-reset ThemeConfig.
//
// Driven through a real ThemeProvider (in-memory persistence + injected
// systemAccent) so the effective-config math is exercised end to end, not
// mocked.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Persistence, Preferences } from "@hive/theming";
import { ThemeProvider } from "@hive/theming";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mount, setupDom, teardownDom } from "../../__tests__/happy-dom-env.ts";
import {
  type UseAppearanceSettingsReturn,
  useAppearanceSettings,
} from "../useAppearanceSettings.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function memoryPersistence(initial: Preferences): Persistence {
  let stored: Preferences = initial;
  return {
    load: async () => stored,
    save: async (prefs) => {
      stored = prefs;
    },
  };
}

// Bridge the hook's return value out of the tree so the test can call its
// mutators and read its derived state between act() flushes.
function Probe({ onValue }: { onValue: (v: UseAppearanceSettingsReturn) => void }): null {
  const value = useAppearanceSettings();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

let activeRoot: Root | null = null;
let hadHive: boolean;

beforeAll(() => {
  setupDom();
  hadHive = "__hive" in window;
  // systemAccentAvailable keys off getSystemAccent being a function (the
  // Electron bridge). The actual OS accent reaches the hook via ThemeProvider's
  // `systemAccent` prop, so this stub just needs to be present and typed.
  window.__hive = {
    baseUrl: "http://localhost",
    token: "test-token",
    getSystemAccent: async () => null,
  };
});
afterAll(async () => {
  if (!hadHive) delete window.__hive;
  await teardownDom();
});
afterEach(async () => {
  if (activeRoot) {
    const r = activeRoot;
    await act(async () => {
      r.unmount();
    });
    activeRoot = null;
  }
});

async function render(
  prefs: Preferences,
  systemAccent: string | null,
): Promise<{
  latest: () => UseAppearanceSettingsReturn;
}> {
  let captured: UseAppearanceSettingsReturn | null = null;
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(
      <ThemeProvider
        persistence={memoryPersistence(prefs)}
        bootstrap={prefs}
        systemAccent={systemAccent}
      >
        <Probe
          onValue={(v) => {
            captured = v;
          }}
        />
      </ThemeProvider>,
    );
  });
  await flush();
  return {
    latest: () => {
      if (!captured) throw new Error("hook never rendered");
      return captured;
    },
  };
}

const BASE: Preferences = {
  mode: "light",
  light: { themeId: "default", accent: "#ff0000" },
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
  useSystemAccent: false,
};

describe("useAppearanceSettings — accent display", () => {
  test("system-accent ON → Accent control shows the applied OS accent, not the override", async () => {
    const prefs: Preferences = { ...BASE, useSystemAccent: true };
    const { latest } = await render(prefs, "#0a84ff");
    expect(latest().accentLockedBySystem).toBe(true);
    // The per-mode override is #ff0000, but the applied accent is the OS one.
    expect(latest().accentDisplayValue).toBe("#0a84ff");
    expect(latest().resolved.config.accent).toBe("#0a84ff");
  });

  test("system-accent OFF → Accent control shows the per-mode override", async () => {
    const prefs: Preferences = { ...BASE, useSystemAccent: false };
    const { latest } = await render(prefs, "#0a84ff");
    expect(latest().accentLockedBySystem).toBe(false);
    expect(latest().accentDisplayValue).toBe("#ff0000");
  });

  test("system-accent ON but no host accent → NOT locked, shows the per-mode override", async () => {
    // The async-boot window / a host with no accent: opted in, but nothing
    // applied. The control must not lock-and-show the dormant override under a
    // "using your system accent" label.
    const prefs: Preferences = { ...BASE, useSystemAccent: true };
    const { latest } = await render(prefs, null);
    expect(latest().accentLockedBySystem).toBe(false);
    expect(latest().accentDisplayValue).toBe("#ff0000");
  });
});

describe("useAppearanceSettings — reset / undo", () => {
  test("resetOverrides clears overrides; undoReset restores the exact config", async () => {
    const prefs: Preferences = {
      ...BASE,
      light: {
        themeId: "default",
        accent: "#ff0000",
        fontUi: "Inter",
        fontUiSize: 16,
        contrast: 70,
        translucentSidebar: true,
      },
    };
    const { latest } = await render(prefs, null);

    const before = latest().editingConfig;
    expect(before).toEqual({
      themeId: "default",
      accent: "#ff0000",
      fontUi: "Inter",
      fontUiSize: 16,
      contrast: 70,
      translucentSidebar: true,
    });

    await act(async () => {
      latest().resetOverrides();
    });
    await flush();

    // Cleared to just the named-palette selection.
    expect(latest().editingConfig).toEqual({ themeId: "default" });
    expect(latest().hasOverrides).toBe(false);
    expect(latest().canUndoReset).toBe(true);

    await act(async () => {
      latest().undoReset();
    });
    await flush();

    // Exact pre-reset config restored, and the affordance is gone.
    expect(latest().editingConfig).toEqual(before);
    expect(latest().canUndoReset).toBe(false);
  });

  test("switching mode after a reset strands the snapshot — canUndoReset goes false", async () => {
    const prefs: Preferences = {
      ...BASE,
      mode: "light",
      light: { themeId: "default", accent: "#ff0000" },
    };
    const { latest } = await render(prefs, null);

    await act(async () => {
      latest().resetOverrides();
    });
    await flush();
    expect(latest().canUndoReset).toBe(true);

    // Switch the edited mode to dark; the light-mode snapshot no longer applies.
    await act(async () => {
      latest().patchPrefs({ mode: "dark" });
    });
    await flush();
    expect(latest().editingMode).toBe("dark");
    expect(latest().canUndoReset).toBe(false);
  });

  test("a second reset re-captures; undo restores the most recent pre-reset state", async () => {
    const prefs: Preferences = {
      ...BASE,
      light: { themeId: "default", accent: "#abcdef" },
    };
    const { latest } = await render(prefs, null);

    // First reset, then re-apply a different override (latest pre-reset wins).
    await act(async () => {
      latest().resetOverrides();
    });
    await flush();
    await act(async () => {
      latest().patchConfig({ accent: "#123456" });
    });
    await flush();
    const secondBefore = latest().editingConfig;
    expect(secondBefore).toEqual({ themeId: "default", accent: "#123456" });

    await act(async () => {
      latest().resetOverrides();
    });
    await flush();
    expect(latest().editingConfig).toEqual({ themeId: "default" });

    await act(async () => {
      latest().undoReset();
    });
    await flush();
    expect(latest().editingConfig).toEqual(secondBefore);
  });
});
