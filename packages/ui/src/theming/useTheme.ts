// useTheme — typed hook into the ThemeProvider context. Throws if called
// outside a provider so misuse is caught at first render, not silently
// degraded.

import { useContext } from "react";
import { ThemeContext, type ThemeContextValue } from "./ThemeProvider.tsx";

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme() called outside a <ThemeProvider>");
  }
  return ctx;
}
