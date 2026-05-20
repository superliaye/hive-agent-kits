// ChromeBridge — pipes the resolved theme to Electron's window chrome
// (title-bar overlay + nativeTheme.themeSource). Lives outside the
// portable theming module so the module stays Electron-agnostic.
//
// In a plain browser tab (Vite dev), window.__hive is undefined and this
// component is a silent no-op.

import { useEffect } from "react";
import { useTheme } from "../theming/index.ts";

export function ChromeBridge(): null {
  const { resolved } = useTheme();
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__hive?.setChromeTheme : undefined;
    if (!bridge) return;
    const bg = resolved.tokens["color-bg-base"];
    const fg = resolved.tokens["color-fg-default"];
    if (!bg || !fg) return;
    void bridge({ mode: resolved.resolvedMode, bg, fg });
  }, [resolved.resolvedMode, resolved.tokens]);
  return null;
}
