// Notes someone has closed stay closed in this browser. Everything they
// point to is still in Settings.
import { useState } from "react";

const read = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

export function useDismissed(key: string): [boolean, () => void] {
  const [hidden, setHidden] = useState(() => read(key));
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(key, "1");
    } catch {}
  };
  return [hidden, hide];
}

/** the "set up an AI" note on the boards page and above the chat */
export const AI_SETUP_NOTE = "hh_hide_ai_setup";
