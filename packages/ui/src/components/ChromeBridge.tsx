// ChromeBridge — pipes the resolved theme to Electron's window chrome
// (title-bar overlay + nativeTheme.themeSource). Lives outside the
// portable theming module so the module stays Electron-agnostic.
//
// In a plain browser tab (Vite dev), window.__hive is undefined and this
// component is a silent no-op.

import { useTheme } from "@hive/theming";
import { useEffect } from "react";

export function ChromeBridge(): null {
  const { resolved } = useTheme();
  // Depend on the two scalars we actually pipe to IPC, not the whole
  // tokens object. resolveTokens() returns a fresh TokenMap on every
  // change (font-size, contrast, etc), so depending on the object would
  // re-fire setChromeTheme on every keystroke into the font-size input.
  const bg = resolved.tokens["color-bg-base"];
  const fg = resolved.tokens["color-fg-default"];
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__hive?.setChromeTheme : undefined;
    if (!bridge) return;
    if (!bg || !fg) return;
    void bridge({ mode: resolved.resolvedMode, bg, fg });
  }, [resolved.resolvedMode, bg, fg]);
  return null;
}
