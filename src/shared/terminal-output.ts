/** Captured output remains text, including terminal and bidirectional controls. */
export function escapeTerminalOutput(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
