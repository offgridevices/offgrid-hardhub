import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AI_SETUP_NOTE, useDismissed } from "../src/lib/dismissed";

// React's act() wants to be told it is in a test
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Note() {
  const [hidden, hide] = useDismissed(AI_SETUP_NOTE);
  return hidden ? null : <button onClick={hide}>close</button>;
}

let host: HTMLDivElement;
let root: Root;
const mount = () => act(() => root.render(<Note />));
const button = () => host.querySelector("button");

beforeEach(() => {
  localStorage.clear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("a note someone closed", () => {
  it("shows until closed, then stays closed when the screen is built again", () => {
    mount();
    expect(button()).not.toBeNull();
    act(() => button()!.click());
    expect(button()).toBeNull();
    expect(localStorage.getItem(AI_SETUP_NOTE)).toBe("1");

    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(button()).toBeNull();
  });

  it("closes for now and comes back next time when the browser blocks storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    expect(button()).not.toBeNull();
    act(() => button()!.click());
    expect(button()).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(button()).not.toBeNull();
  });
});
