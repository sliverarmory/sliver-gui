const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

function isSeparator(character: string): boolean {
  return character === " " || character === "\t" || character === "\n";
}

/**
 * Split a process argument string using the shell-lexical rules used by the
 * pinned Sliver console's go-shellquote parser. This only builds argv: it does
 * not invoke a shell, expand variables, or interpret metacharacters.
 */
export function parseProcessArgv(input: string): string[] {
  const arguments_: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index);

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && index + 1 < input.length && DOUBLE_QUOTE_ESCAPES.has(input.charAt(index + 1))) {
        const escaped = input.charAt(++index);
        if (escaped !== "\n") word += escaped;
      } else {
        word += character;
      }
      continue;
    }

    if (isSeparator(character)) {
      if (wordStarted) arguments_.push(word);
      word = "";
      wordStarted = false;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      wordStarted = true;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= input.length) {
        throw new Error("Arguments end with a backslash escape. Add a character after the backslash or remove it.");
      }
      const escaped = input.charAt(++index);
      if (escaped !== "\n") {
        word += escaped;
        wordStarted = true;
      }
      continue;
    }

    word += character;
    wordStarted = true;
  }

  if (quote === "single") {
    throw new Error("Unterminated single-quoted argument. Add a closing ' character.");
  }
  if (quote === "double") {
    throw new Error('Unterminated double-quoted argument. Add a closing " character.');
  }
  if (wordStarted) arguments_.push(word);

  return arguments_;
}
