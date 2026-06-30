// SettingRow — the disciplined dev-settings building block: a compact row whose
// explanation lives behind an accessible info trigger, not as always-visible
// prose. Asserts the label↔control binding, the control slot, the always-present
// accessible description the control references, and the visible tooltip's
// hidden-at-rest / reveal-on-focus-and-hover / close-on-blur behavior.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mount, setupDom, teardownDom } from "../../__tests__/happy-dom-env.ts";
import { SettingRow } from "../SettingRow.tsx";

let activeRoot: Root | null = null;

beforeAll(() => setupDom());
afterAll(() => teardownDom());
afterEach(async () => {
  if (activeRoot) {
    const r = activeRoot;
    await act(async () => {
      r.unmount();
    });
    activeRoot = null;
  }
});

async function render(node: JSX.Element): Promise<HTMLElement> {
  const host = mount();
  const root = createRoot(host);
  activeRoot = root;
  await act(async () => {
    root.render(node);
  });
  return host;
}

function row(explanation: string): JSX.Element {
  return (
    <SettingRow label="Deploy to real home directory" explanation={explanation}>
      {({ controlId, describedById }) => (
        <input
          id={controlId}
          type="checkbox"
          data-testid="row-ctrl"
          aria-describedby={describedById}
        />
      )}
    </SettingRow>
  );
}

describe("SettingRow", () => {
  test("renders the label, control slot, and an accessible info trigger", async () => {
    const host = await render(row("The full explanation of the consequence."));

    const control = host.querySelector<HTMLInputElement>('[data-testid="row-ctrl"]');
    expect(control).not.toBeNull();

    // Label binds to the control via the minted controlId.
    const label = host.querySelector<HTMLLabelElement>("label[for]");
    expect(label?.textContent).toBe("Deploy to real home directory");
    expect(label?.getAttribute("for")).toBe(control?.id);

    // Info trigger is a keyboard-focusable button with an accessible name.
    const trigger = host.querySelector<HTMLButtonElement>(".setting-info-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-label")).toBe("About Deploy to real home directory");
  });

  test("the control's accessible description is an always-present node, not the hidden popover", async () => {
    const explanation = "Off by default lands in a sandbox; on overwrites real homes.";
    const host = await render(row(explanation));

    const control = host.querySelector<HTMLInputElement>('[data-testid="row-ctrl"]');
    // The description the control references is the always-present sr-only node…
    const desc = host.querySelector<HTMLElement>('[data-testid="setting-info-desc"]');
    expect(desc).not.toBeNull();
    expect(desc?.textContent).toBe(explanation);
    expect(desc?.hidden).toBe(false); // never display:none — stays in the a11y tree
    expect(control?.getAttribute("aria-describedby")).toBe(desc?.id);

    // …and is a DISTINCT element from the visible tooltip (which IS hidden at rest).
    const tip = host.querySelector<HTMLElement>('[data-testid="setting-info-tip"]');
    expect(tip?.id).not.toBe(desc?.id);
  });

  test("the visible tooltip is hidden at rest, revealed on focus, and closed on blur", async () => {
    const explanation = "Off by default lands in a sandbox; on overwrites real homes.";
    const host = await render(row(explanation));

    const trigger = host.querySelector<HTMLButtonElement>(".setting-info-trigger");
    const tip = host.querySelector<HTMLElement>('[data-testid="setting-info-tip"]');
    if (!trigger || !tip) throw new Error("info trigger/tooltip not found");

    expect(tip.textContent).toBe(explanation);
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);

    // Hidden at rest (not always-visible prose).
    expect(tip.hidden).toBe(true);

    // Revealed on keyboard focus. React delegates focus via the bubbling
    // `focusin` event, so that drives the synthetic onFocus handler.
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(tip.hidden).toBe(false);

    // Closed again on blur (focusout).
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(tip.hidden).toBe(true);
  });

  test("hovering from trigger onto the tooltip keeps it open (wrapper owns open-state)", async () => {
    const host = await render(row("Off by default lands in a sandbox."));

    const info = host.querySelector<HTMLElement>(".setting-info");
    const tip = host.querySelector<HTMLElement>('[data-testid="setting-info-tip"]');
    if (!info || !tip) throw new Error("info wrapper/tooltip not found");

    // Entering the wrapper (which spans trigger + the gap + the tooltip) opens it
    // and a single leave on the wrapper — not on each child — closes it, so
    // crossing the gap from icon to tooltip never closes it mid-transit. React
    // synthesizes onMouseEnter/onMouseLeave from the bubbling mouseover/mouseout
    // events, so those are what the handlers actually listen to.
    await act(async () => {
      info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(tip.hidden).toBe(false);

    await act(async () => {
      info.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(tip.hidden).toBe(true);
  });
});
