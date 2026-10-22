import { resolve } from "node:path";

/** OS launch arguments are file paths, never RDP commands, URLs, or auto-connect requests. */
export function rdpFilesFromArguments(argv: readonly string[], cwd: string): readonly string[] {
  return [...new Set(argv.filter((argument) => !argument.startsWith("-") && /\.rdp$/iu.test(argument) &&
    !/^[a-z][a-z0-9+.-]*:\/\//iu.test(argument) && !/[\u0000-\u001f\u007f]/u.test(argument) && argument.length <= 4096)
    .map((argument) => resolve(cwd, argument)))].slice(0, 32);
}
