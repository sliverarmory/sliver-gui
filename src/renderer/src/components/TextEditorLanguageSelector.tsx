import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Autocomplete, ListBox, SearchField } from "@heroui/react";
import { useMemo, useState } from "react";
import type { Key } from "react-aria-components";

import {
  rankMonacoLanguageOptions,
  type MonacoLanguageOption,
} from "../editor/monaco-language-catalog";
import { monacoLanguageIcon } from "../editor/monaco-language-icons";

export interface TextEditorLanguageSelectorProps {
  readonly language: string;
  readonly languages: readonly MonacoLanguageOption[];
  readonly onChange: (language: string) => void;
}

export function TextEditorLanguageSelector({
  language,
  languages,
  onChange,
}: TextEditorLanguageSelectorProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const rankedLanguages = useMemo(() => rankMonacoLanguageOptions(languages, query), [languages, query]);
  const selected = languages.find(({ id }) => id === language);

  return (
    <Autocomplete
      aria-label="Document language"
      className="w-48 max-w-full"
      selectionMode="single"
      value={language}
      variant="secondary"
      onChange={(key: Key | Key[] | null) => {
        if (key === null || Array.isArray(key)) return;
        const nextLanguage = String(key);
        if (languages.some(({ id }) => id === nextLanguage)) onChange(nextLanguage);
      }}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <Autocomplete.Trigger className="min-w-0">
        <Autocomplete.Value>
          <span className="flex min-w-0 items-center gap-2">
            <FontAwesomeIcon
              aria-hidden
              className="size-4 shrink-0 text-muted"
              icon={monacoLanguageIcon(selected?.id ?? language)}
            />
            <span className="truncate">{selected?.label ?? language}</span>
          </span>
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <Autocomplete.Popover
        style={{ width: "min(20rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }}
      >
        <Autocomplete.Filter inputValue={query} filter={() => true} onInputChange={setQuery}>
          <SearchField autoFocus aria-label="Search syntax languages" name="text-editor-language-search" variant="secondary">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Search languages…" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox
            renderEmptyState={() => (
              <p className="px-3 py-6 text-center text-sm text-muted">No matching languages.</p>
            )}
          >
            {rankedLanguages.map((option) => (
              <ListBox.Item
                id={option.id}
                key={option.id}
                textValue={option.label}
              >
                <FontAwesomeIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted"
                  icon={monacoLanguageIcon(option.id)}
                />
                <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  );
}
