import type { ClaudeCodeExtendedKeyboardMode } from './claudeCodeTuiSupport';

export class ClaudeCodeSessionState {
  private activeTui = false;
  private modifyOtherKeysEnabled = false;

  reset(): void {
    this.activeTui = false;
    this.modifyOtherKeysEnabled = false;
  }

  observeXtversionQuery(): void {
    this.activeTui = true;
  }

  observeModifyOtherKeysMode(enabled: boolean): void {
    this.modifyOtherKeysEnabled = enabled;
    this.activeTui = enabled;
  }

  observeShellPrompt(): void {
    this.reset();
  }

  isActive(): boolean {
    return this.activeTui;
  }

  getExtendedKeyboardMode(): ClaudeCodeExtendedKeyboardMode {
    return this.modifyOtherKeysEnabled ? 'modifyOtherKeys' : 'none';
  }
}
