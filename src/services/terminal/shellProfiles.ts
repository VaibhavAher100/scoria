import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type { ShellType, TerminalShellType } from '@/settings/settings';

const WINDOWS_DEFAULT_SHELLS: ShellType[] = ['cmd', 'powershell', 'pwsh', 'gitbash', 'wsl'];
const UNIX_DEFAULT_SHELLS: ShellType[] = ['bash', 'zsh'];
const OPTIONAL_TERMINAL_SHELLS: TerminalShellType[] = ['tmux'];

const TERMINAL_SHELL_COMMON_PATHS: Record<TerminalShellType, string[]> = {
  tmux: [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
    'C:\\msys64\\usr\\bin\\tmux.exe',
    'C:\\Program Files\\Git\\usr\\bin\\tmux.exe',
  ],
};

export function getSelectableShellTypes(currentShell?: ShellType): ShellType[] {
  const shellTypes = process.platform === 'win32'
    ? [...WINDOWS_DEFAULT_SHELLS]
    : [...UNIX_DEFAULT_SHELLS];

  for (const shellType of detectAvailableTerminalShells()) {
    addUniqueShellType(shellTypes, shellType);
  }

  if (currentShell) {
    addUniqueShellType(shellTypes, currentShell);
  }

  addUniqueShellType(shellTypes, 'custom');
  return shellTypes;
}

export function isTerminalShellType(value: string): value is TerminalShellType {
  return OPTIONAL_TERMINAL_SHELLS.includes(value as TerminalShellType);
}

function detectAvailableTerminalShells(): TerminalShellType[] {
  if (Platform.isMobile) return [];

  return OPTIONAL_TERMINAL_SHELLS.filter((shellType) =>
    isTerminalShellAvailable(shellType)
  );
}

function isTerminalShellAvailable(shellType: TerminalShellType): boolean {
  return commandExists(shellType)
    || TERMINAL_SHELL_COMMON_PATHS[shellType].some((candidate) => fs.existsSync(candidate));
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? '';
  if (!pathValue) return false;

  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
    : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === 'win32' ? `${command}${extension}` : command);
      if (fs.existsSync(candidate)) {
        return true;
      }
    }
  }

  return false;
}

function addUniqueShellType(shellTypes: ShellType[], shellType: ShellType): void {
  if (!shellTypes.includes(shellType)) {
    shellTypes.push(shellType);
  }
}
