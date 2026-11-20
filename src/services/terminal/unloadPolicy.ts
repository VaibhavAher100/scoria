/**
 * Decisions for terminal teardown during a plugin unload (defect D1).
 *
 * Obsidian runs a plugin's registered cleanups before `onunload()`. The
 * `registerView` cleanup unregisters the view type, and Obsidian then swaps
 * every terminal leaf to a placeholder view. That swap closes each
 * TerminalView, so the view-close path runs before `onunload()` can apply
 * keep-alive. These helpers let the view-close path know that an unload is in
 * progress and what it must keep.
 */

/**
 * Whether the daemon and its sessions should outlive this plugin unload.
 *
 * Obsidian sets the private field `_userDisabled` to `true` only when the user
 * turns the plugin off in Settings (`disablePluginAndSave`). A reload, an
 * update or `disablePlugin()` leaves it `false`. If the field is missing or not
 * a boolean (a future Obsidian change), keep the sessions: that is the
 * behaviour before this fix, and the orphan timeout still cleans up.
 */
export function shouldKeepSessionsOnUnload(
  keepServerAliveOnUnload: boolean,
  userDisabled: unknown,
): boolean {
  if (!keepServerAliveOnUnload) return false;
  return userDisabled !== true;
}

export interface TerminalCloseDecision {
  /** Pass to `TerminalInstance.destroy(keepSession)`. */
  keepSession: boolean;
  /** Stop the server from the view-close path. */
  shutdownServer: boolean;
}

/**
 * What a terminal close must do.
 *
 * - During a plugin unload, `onunload()` owns the server shutdown, so the
 *   close never stops the server. It keeps the session only in keep mode.
 * - Outside an unload, the user closed a tab: kill the shell, and stop the
 *   server when that was the last terminal (behaviour before this fix).
 */
export function decideTerminalClose(
  unloading: boolean,
  keepSessionsOnUnload: boolean,
  remainingTerminals: number,
): TerminalCloseDecision {
  if (unloading) {
    return { keepSession: keepSessionsOnUnload, shutdownServer: false };
  }
  return { keepSession: false, shutdownServer: remainingTerminals === 0 };
}
