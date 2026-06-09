// G1 regression: inline rename inside an interactive nav row must not let the
// row's role="button" onKeyDown eat the spacebar or re-fire selection on Enter.
//
// The nav row (ChatPage) is `<li role="button" onKeyDown=…>` that, on Space or
// Enter, does e.preventDefault() + setActiveId(). The rename <input> is a
// descendant of that row. Without stopPropagation in the editor's onKeyDown,
// every keystroke bubbles to the row:
//   - Space: the row's handler runs preventDefault() -> the space never reaches
//     the input, so multi-word titles are impossible from the nav-row rename.
//   - Enter: the input commits, then the same Enter bubbles and the row re-fires
//     its select -> a stray selection change on commit.
//
// Both bugs are keydown *propagation* bugs. These tests render the real
// InlineTitle inside a row mirroring ChatPage's handler and assert the row never
// sees keys the editor owns, and that those keys are not preventDefault'd by the
// row (so the browser would still insert/commit them). The fix is InlineTitle's
// e.stopPropagation() in the input onKeyDown.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { type Root, createRoot } from "react-dom/client";
import { InlineTitle } from "../components/InlineTitle.tsx";
import { keydown, mount, setupDom, teardownDom } from "./happy-dom-env.ts";

beforeAll(() => setupDom());
afterAll(() => teardownDom());

let activeRoot: Root | null = null;
afterEach(async () => {
  if (activeRoot) {
    const r = activeRoot;
    await act(async () => {
      r.unmount();
    });
    activeRoot = null;
  }
});

// Renders InlineTitle (edit mode) inside a row whose onKeyDown mirrors
// ChatPage's interactive `<li role="button">`: on Enter/Space it preventDefaults
// and "selects". Returns the input plus a count of how many times the row's
// select handler ran.
async function renderRow(): Promise<{
  input: HTMLInputElement;
  rowSelected: () => number;
}> {
  let rowSelectedCount = 0;
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;

  function Harness(): JSX.Element {
    return createElement(
      "li",
      {
        role: "button",
        tabIndex: 0,
        onKeyDown: (e: ReactKeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            rowSelectedCount += 1;
          }
        },
      },
      createElement(InlineTitle, {
        value: "foo",
        placeholder: "Untitled",
        editing: true,
        onEditingChange: () => {},
        onCommit: () => {},
        ariaLabel: "Rename thread",
      }),
    );
  }

  await act(async () => {
    root.render(createElement(Harness));
  });

  const input = host.querySelector("input");
  if (!input) throw new Error("InlineTitle did not render an input");
  return { input, rowSelected: () => rowSelectedCount };
}

describe("InlineTitle rename inside an interactive nav row (G1)", () => {
  test("space in the editor does not reach the row's select handler", async () => {
    const { input, rowSelected } = await renderRow();
    await act(async () => {
      input.dispatchEvent(keydown(" "));
    });
    // Bug repro without the fix: the row handler runs (and preventDefaults the
    // space, blocking it from the title input).
    expect(rowSelected()).toBe(0);
  });

  test("space in the editor is not preventDefault'd (the char can be typed)", async () => {
    const { input } = await renderRow();
    const ev = keydown(" ");
    await act(async () => {
      input.dispatchEvent(ev);
    });
    // The editor owns the space and leaves it to the browser; only the row's
    // handler (which the fix now blocks) would have preventDefault'd it.
    expect(ev.defaultPrevented).toBe(false);
  });

  test("Enter does not re-fire the row's select handler on commit", async () => {
    const { input, rowSelected } = await renderRow();
    await act(async () => {
      input.dispatchEvent(keydown("Enter"));
    });
    expect(rowSelected()).toBe(0);
  });
});
