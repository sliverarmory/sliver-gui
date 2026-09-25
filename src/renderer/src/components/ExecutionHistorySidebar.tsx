import { Button } from "@heroui/react";
import { ChatListView } from "@heroui-pro/react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrashCan } from "@fortawesome/free-solid-svg-icons";

import { ExecutionHistoryScrollShadow } from "./ExecutionHistoryScrollShadow";

export interface ExecutionHistorySidebarItem {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
  readonly stateLabel: string;
  readonly statusIcon: IconDefinition;
  readonly statusColor: string;
}

interface ExecutionHistorySidebarProps {
  readonly label: string;
  readonly items: readonly ExecutionHistorySidebarItem[];
  readonly selectedId: string | undefined;
  readonly newExecutionKey: string;
  readonly executionKeyPrefix: string;
  readonly onSelect: (id: string | null) => void;
  readonly onClearAll: () => void;
}

/** One sidebar layout for Process and BOF execution history. */
export function ExecutionHistorySidebar({
  label,
  items,
  selectedId,
  newExecutionKey,
  executionKeyPrefix,
  onSelect,
  onClearAll,
}: ExecutionHistorySidebarProps): React.JSX.Element {
  const showingNew = selectedId === undefined;

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-b border-separator bg-background p-3 sm:border-b-0 sm:border-r sm:p-4">
      <nav aria-label={label} className="flex min-h-0 flex-col sm:flex-1 sm:overflow-hidden">
        <ChatListView
          aria-label={label}
          className="shrink-0"
          selectedKeys={showingNew ? new Set([newExecutionKey]) : new Set()}
          selectionBehavior="replace"
          selectionMode="single"
          onSelectionChange={(keys) => {
            if (keys !== "all" && keys.has(newExecutionKey)) onSelect(null);
          }}
        >
          <ChatListView.Item
            className="rounded-xl"
            id={newExecutionKey}
            style={{
              backgroundColor: showingNew ? "var(--color-surface)" : "var(--color-surface-secondary)",
              borderBottomColor: "transparent",
              boxShadow: showingNew ? "var(--shadow-surface)" : undefined,
            }}
            textValue="New Execution"
          >
            <ChatListView.ItemContent>
              <ChatListView.Icon>
                <FontAwesomeIcon aria-hidden className="size-3.5 text-accent" icon={faPlus} />
              </ChatListView.Icon>
              <ChatListView.Text>
                <ChatListView.Title>New Execution</ChatListView.Title>
              </ChatListView.Text>
            </ChatListView.ItemContent>
          </ChatListView.Item>
        </ChatListView>
        <ExecutionHistoryScrollShadow>
          <ChatListView
            aria-label={`${label} items`}
            className="space-y-1"
            selectedKeys={showingNew ? new Set() : new Set([`${executionKeyPrefix}${selectedId}`])}
            selectionBehavior="replace"
            selectionMode="single"
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const key = keys.values().next().value;
              if (typeof key === "string" && key.startsWith(executionKeyPrefix)) {
                onSelect(key.slice(executionKeyPrefix.length));
              }
            }}
          >
            {items.map((item) => {
              const isSelected = item.id === selectedId;
              return (
                <ChatListView.Item
                  className="rounded-xl"
                  id={`${executionKeyPrefix}${item.id}`}
                  key={item.id}
                  style={{
                    backgroundColor: isSelected ? "var(--color-surface)" : undefined,
                    borderBottomColor: "transparent",
                    boxShadow: isSelected ? "var(--shadow-surface)" : undefined,
                  }}
                  textValue={item.title}
                >
                  <ChatListView.ItemContent>
                    <ChatListView.Icon>
                      <FontAwesomeIcon aria-hidden className={`size-3.5 ${item.statusColor}`} icon={item.statusIcon} />
                    </ChatListView.Icon>
                    <ChatListView.Text>
                      <ChatListView.Title className="font-mono text-xs" title={item.title}>{item.title}</ChatListView.Title>
                      <ChatListView.Preview>
                        {new Date(item.startedAt).toLocaleTimeString()} · {item.stateLabel}
                      </ChatListView.Preview>
                    </ChatListView.Text>
                  </ChatListView.ItemContent>
                </ChatListView.Item>
              );
            })}
          </ChatListView>
        </ExecutionHistoryScrollShadow>
      </nav>
      {items.length === 0 ? <p className="px-4 pt-2 text-xs text-muted">No executions yet.</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-xs text-muted">History · {items.length}</span>
        <Button isDisabled={items.length === 0} size="sm" variant="danger-soft" onPress={onClearAll}>
          <FontAwesomeIcon aria-hidden className="size-3" icon={faTrashCan} />
          Clear history
        </Button>
      </div>
    </aside>
  );
}
