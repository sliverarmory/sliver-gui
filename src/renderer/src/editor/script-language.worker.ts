import { create, initialize } from "monaco-editor/languages/features/typescript/ts.worker";

import { SCRIPT_WORKER_DATA } from "./script-language-config";

// This trusted analysis worker parses source for editor diagnostics/completions.
// It never evaluates source. The QuickJS execution worker is entirely separate.
initialize((context) => create(context, SCRIPT_WORKER_DATA));
