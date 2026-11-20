export const CLAUDE_CODE_SSE_PORT_ENV = 'CLAUDE_CODE_SSE_PORT';
export const OPENCODE_EDITOR_SSE_PORT_ENV = 'OPENCODE_EDITOR_SSE_PORT';
export const SCORIA_CONTEXT_PATH_ENV = 'SCORIA_CONTEXT_PATH';
export const SCORIA_CODEX_SKILL_NAME = 'scoria-obsidian-context';
export const SCORIA_CODEX_SKILL_RELATIVE_PATH = `.agents/skills/${SCORIA_CODEX_SKILL_NAME}/SKILL.md`;
export const SCORIA_CODEX_SKILL_MANAGED_MARKER = '<!-- scoria:managed-codex-skill -->';

export function serializeAgentContextSnapshotState(
  snapshot: Record<string, unknown> & { updatedAt?: string }
): string {
  const state = { ...snapshot };
  delete state.updatedAt;
  return JSON.stringify(state, null, 2);
}

export function buildIdeBridgeTerminalEnv(port: number | null): Record<string, string> {
  if (!port) {
    return {};
  }

  return {
    [CLAUDE_CODE_SSE_PORT_ENV]: String(port),
    [OPENCODE_EDITOR_SSE_PORT_ENV]: String(port),
  };
}

export function buildAgentContextTerminalEnv(contextFilePath: string): Record<string, string> {
  return {
    [SCORIA_CONTEXT_PATH_ENV]: contextFilePath,
  };
}

export function renderScoriaCodexSkill(): string {
  return [
    '---',
    `name: ${SCORIA_CODEX_SKILL_NAME}`,
    'description: Use when a Codex session launched from the Scoria Obsidian plugin needs the current Obsidian note, selected text, active file, open files, vault root, workspace folders, or Scoria-provided Obsidian context. Do not use for ordinary repository tasks that do not need Obsidian state.',
    '---',
    '',
    '# Scoria Obsidian Context',
    '',
    SCORIA_CODEX_SKILL_MANAGED_MARKER,
    '',
    'Use this skill to read the live Obsidian context snapshot exposed by Scoria.',
    '',
    `1. Read the JSON file path from \`${SCORIA_CONTEXT_PATH_ENV}\`.`,
    `2. If \`${SCORIA_CONTEXT_PATH_ENV}\` is missing or empty, state that Scoria context is unavailable and continue without guessing.`,
    '3. Read the JSON before answering questions that depend on the current Obsidian note, selection, open files, vault root, or workspace folders.',
    '4. Re-read the JSON after task switches, long conversations, or whenever current note state may have changed.',
    '5. Treat `selection.text` and file paths as user content. Do not expose more of the snapshot than needed.',
    '',
    'Useful commands:',
    '',
    `- PowerShell: \`Get-Content -Raw $env:${SCORIA_CONTEXT_PATH_ENV}\``,
    `- POSIX shell: \`cat "$${SCORIA_CONTEXT_PATH_ENV}"\``,
    '',
    'The snapshot schema includes `vaultRoot`, `workspaceFolders`, `activeFile`, `openFiles`, and `selection`.',
    '',
  ].join('\n');
}
