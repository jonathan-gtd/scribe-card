/** What a card remembers between visits.
 *
 * A range someone picked has to survive the browser closing and Home Assistant
 * restarting, and ideally the machine changing too. Two layers do that:
 *
 * - `frontend/set_user_data`, the websocket store the frontend keeps its own
 *   preferences in. Per user, on the server, so it outlives everything local.
 * - `localStorage`, written at the same time and read first, so a card opens
 *   on the range it was left on instead of flickering through the default
 *   while a websocket round trip happens. It is also the whole answer when the
 *   user store cannot be reached.
 *
 * Each card gets its own key rather than a shared object, so two cards saving
 * at once cannot overwrite each other.
 */

import type { HomeAssistant } from "./types";

const PREFIX = "scribe-card.";

/**
 * A short, stable name for a card.
 *
 * A Lovelace configuration carries no identifier, so the card is named by what
 * it asks for. Rewriting the query loses the choice, which is the right
 * outcome: it is not the same card any more. `storage_key` pins it for anyone
 * who disagrees.
 */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function storageKey(name: string): string {
  return `${PREFIX}${name}`;
}

/** What the browser remembers, which is there before anything is asked. */
export function readLocal(key: string): unknown {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? undefined : JSON.parse(stored);
  } catch {
    // A private window, storage turned off, or something that is not JSON.
    return undefined;
  }
}

/** What Home Assistant remembers for this user, wherever they are reading it. */
export async function read(hass: HomeAssistant, key: string): Promise<unknown> {
  try {
    const result = await hass.connection?.sendMessagePromise<{ value?: unknown }>({
      type: "frontend/get_user_data",
      key,
    });
    return result?.value ?? undefined;
  } catch {
    return undefined;
  }
}

/** Both layers, and neither failing is worth telling anyone about. */
export async function write(hass: HomeAssistant, key: string, value: unknown): Promise<void> {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the user store below is the one that matters.
  }
  try {
    await hass.connection?.sendMessagePromise({
      type: "frontend/set_user_data",
      key,
      value,
    });
  } catch {
    // A card that cannot remember a choice still shows it.
  }
}
