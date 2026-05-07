export interface SynchronizedOutputCompatibilityState {
  synchronizedOutputActive: boolean;
  pendingText: string;
}

const SYNC_OUTPUT_ENABLE = '\x1b[?2026h';
const SYNC_OUTPUT_DISABLE = '\x1b[?2026l';
const ERASE_SCROLLBACK = '\x1b[3J';

export function createSynchronizedOutputCompatibilityState(): SynchronizedOutputCompatibilityState {
  return {
    synchronizedOutputActive: false,
    pendingText: '',
  };
}

/**
 * Some AI TUIs emit ED3 inside synchronized-output redraw blocks while still
 * drawing on the normal buffer. Strip only that sequence before xterm.js sees
 * it so scrollback survives, while leaving the synchronized-output markers and
 * all other escape sequences intact.
 */
export function filterSynchronizedOutputScrollbackPurge(
  input: string,
  state: SynchronizedOutputCompatibilityState,
): string {
  const combined = `${state.pendingText}${input}`;
  let output = '';
  let index = 0;
  let pendingFragment = '';

  while (index < combined.length) {
    const escapeIndex = combined.indexOf('\x1b', index);
    if (escapeIndex === -1) {
      output += combined.slice(index);
      break;
    }

    output += combined.slice(index, escapeIndex);
    const remaining = combined.slice(escapeIndex);

    if (shouldBufferTrackedSequenceFragment(remaining)) {
      pendingFragment = remaining;
      break;
    }

    if (remaining.startsWith(SYNC_OUTPUT_ENABLE)) {
      state.synchronizedOutputActive = true;
      output += SYNC_OUTPUT_ENABLE;
      index = escapeIndex + SYNC_OUTPUT_ENABLE.length;
      continue;
    }

    if (remaining.startsWith(SYNC_OUTPUT_DISABLE)) {
      state.synchronizedOutputActive = false;
      output += SYNC_OUTPUT_DISABLE;
      index = escapeIndex + SYNC_OUTPUT_DISABLE.length;
      continue;
    }

    if (remaining.startsWith(ERASE_SCROLLBACK) && state.synchronizedOutputActive) {
      index = escapeIndex + ERASE_SCROLLBACK.length;
      continue;
    }

    output += combined[escapeIndex];
    index = escapeIndex + 1;
  }

  state.pendingText = pendingFragment;
  return output;
}

function shouldBufferTrackedSequenceFragment(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  return [SYNC_OUTPUT_ENABLE, SYNC_OUTPUT_DISABLE, ERASE_SCROLLBACK]
    .some((sequence) => sequence.startsWith(value) && value.length < sequence.length);
}
