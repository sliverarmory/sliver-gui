import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faApple,
  faCss3Alt,
  faDartLang,
  faDocker,
  faEthereum,
  faGolang,
  faHtml5,
  faJava,
  faJs,
  faJulia,
  faLess,
  faMarkdown,
  faPhp,
  faPostgresql,
  faPython,
  faRProject,
  faRust,
  faSalesforce,
  faSass,
  faSwift,
  faTypescript,
} from "@fortawesome/free-brands-svg-icons";
import {
  faC,
  faCloud,
  faCode,
  faCubes,
  faDatabase,
  faDiagramProject,
  faFileCode,
  faFileLines,
  faGem,
  faHashtag,
  faMicrochip,
  faMoon,
  faTerminal,
} from "@fortawesome/free-solid-svg-icons";

const EXACT_LANGUAGE_ICONS: Readonly<Record<string, IconDefinition>> = Object.freeze({
  apex: faSalesforce,
  css: faCss3Alt,
  dart: faDartLang,
  dockerfile: faDocker,
  elixir: faGem,
  go: faGolang,
  html: faHtml5,
  java: faJava,
  javascript: faJs,
  julia: faJulia,
  less: faLess,
  lua: faMoon,
  markdown: faMarkdown,
  mdx: faMarkdown,
  "objective-c": faApple,
  pgsql: faPostgresql,
  php: faPhp,
  python: faPython,
  r: faRProject,
  ruby: faGem,
  rust: faRust,
  scss: faSass,
  sol: faEthereum,
  swift: faSwift,
  typescript: faTypescript,
});

const LANGUAGE_ICON_GROUPS: readonly Readonly<{ ids: ReadonlySet<string>; icon: IconDefinition }>[] = [
  { ids: new Set(["c", "cpp", "objective-c"]), icon: faC },
  { ids: new Set(["csharp", "fsharp", "qsharp"]), icon: faHashtag },
  { ids: new Set(["azcli", "bat", "powershell", "shell", "tcl"]), icon: faTerminal },
  { ids: new Set(["bicep", "hcl"]), icon: faCloud },
  { ids: new Set(["graphql", "csp"]), icon: faDiagramProject },
  {
    ids: new Set(["cypher", "msdax", "mysql", "pgsql", "powerquery", "redis", "redshift", "sparql", "sql"]),
    icon: faDatabase,
  },
  { ids: new Set(["mips", "pla", "st", "systemverilog", "verilog", "wgsl"]), icon: faMicrochip },
  { ids: new Set(["plaintext", "restructuredtext"]), icon: faFileLines },
  { ids: new Set(["ini", "json", "typespec", "xml", "yaml"]), icon: faFileCode },
  { ids: new Set(["cameligo", "pascaligo", "proto"]), icon: faCubes },
];

/** Returns a recognizable language icon and always provides a code fallback. */
export function monacoLanguageIcon(languageId: string): IconDefinition {
  const normalized = languageId.toLocaleLowerCase("en");
  const exact = EXACT_LANGUAGE_ICONS[normalized];
  if (exact) return exact;
  if (normalized.startsWith("freemarker2") || normalized === "handlebars" ||
    normalized === "liquid" || normalized === "pug" || normalized === "razor" || normalized === "twig") {
    return faFileCode;
  }
  for (const group of LANGUAGE_ICON_GROUPS) {
    if (group.ids.has(normalized)) return group.icon;
  }
  return faCode;
}
