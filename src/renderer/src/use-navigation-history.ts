import { useCallback, useState } from "react";

interface NavigationHistory<T> {
  entries: T[];
  cursor: number;
}

function findAvailableEntry<T>(
  history: NavigationHistory<T>,
  direction: -1 | 1,
  isAvailable?: (entry: T) => boolean,
): number {
  for (
    let cursor = history.cursor + direction;
    cursor >= 0 && cursor < history.entries.length;
    cursor += direction
  ) {
    if (!isAvailable || isAvailable(history.entries[cursor]!)) return cursor;
  }
  return history.cursor;
}

export function useNavigationHistory<T>(initial: T, isAvailable?: (entry: T) => boolean) {
  const [history, setHistory] = useState<NavigationHistory<T>>(() => ({
    entries: [initial],
    cursor: 0,
  }));

  const navigate = useCallback((entry: T) => {
    setHistory((current) => {
      if (Object.is(current.entries[current.cursor], entry)) return current;
      return {
        entries: [...current.entries.slice(0, current.cursor + 1), entry],
        cursor: current.cursor + 1,
      };
    });
  }, []);

  const goBack = useCallback(() => {
    setHistory((current) => {
      const cursor = findAvailableEntry(current, -1, isAvailable);
      return cursor === current.cursor ? current : { ...current, cursor };
    });
  }, [isAvailable]);

  const goForward = useCallback(() => {
    setHistory((current) => {
      const cursor = findAvailableEntry(current, 1, isAvailable);
      return cursor === current.cursor ? current : { ...current, cursor };
    });
  }, [isAvailable]);

  return {
    current: history.entries[history.cursor]!,
    navigate,
    goBack,
    goForward,
    canGoBack: findAvailableEntry(history, -1, isAvailable) !== history.cursor,
    canGoForward: findAvailableEntry(history, 1, isAvailable) !== history.cursor,
  };
}
