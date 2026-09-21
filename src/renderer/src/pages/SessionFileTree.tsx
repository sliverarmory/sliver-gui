import { useEffect, useMemo, useRef, useState } from "react";
import { FileTree } from "@heroui-pro/react";
import { Collection } from "react-aria-components/Collection";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFolder, faFolderOpen } from "@fortawesome/free-solid-svg-icons";

import type { SessionFileEntry } from "../../../shared/session-contracts";

interface FileTreeNode {
  id: string;
  name: string;
  children: FileTreeNode[];
}

interface SessionFileTreeProps {
  path: string;
  breadcrumbs: Array<{ label: string; path: string }>;
  directories: SessionFileEntry[];
  isDisabled: boolean;
  onNavigate: (path: string) => void;
}

export function SessionFileTree({ path, breadcrumbs, directories, isDisabled, onNavigate }: SessionFileTreeProps): React.JSX.Element {
  const { roots, nodes, ancestry } = useMemo(() => {
    const roots: FileTreeNode[] = [];
    const nodes = new Map<string, FileTreeNode>();
    const ancestry: string[] = [];
    let parent: FileTreeNode | undefined;

    for (const [index, crumb] of breadcrumbs.entries()) {
      // Breadcrumbs format separators for display; the listing owns the current path's identity.
      const id = index === breadcrumbs.length - 1 ? path : crumb.path;
      if (nodes.has(id)) continue;
      const node: FileTreeNode = { id, name: crumb.label, children: [] };
      (parent ? parent.children : roots).push(node);
      nodes.set(node.id, node);
      ancestry.push(node.id);
      parent = node;
    }

    const current = nodes.get(path);
    if (current) {
      const children = directories.filter((entry) => entry.isDirectory)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
      for (const directory of children) {
        if (nodes.has(directory.path)) continue;
        const node: FileTreeNode = { id: directory.path, name: directory.name, children: [] };
        current.children.push(node);
        nodes.set(node.id, node);
      }
    }

    return { roots, nodes, ancestry };
  }, [breadcrumbs, directories, path]);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set(ancestry));
  const expandedPath = useRef(path);

  useEffect(() => {
    const pathChanged = expandedPath.current !== path;
    expandedPath.current = path;
    setExpandedKeys((current) => {
      const next = new Set([...current].filter((key) => nodes.has(key)));
      if (pathChanged) for (const key of ancestry) next.add(key);
      return next.size === current.size && [...next].every((key) => current.has(key)) ? current : next;
    });
  }, [ancestry, nodes, path]);

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <h3 className="px-3 py-2 text-xs font-medium text-foreground">Folders</h3>
      <FileTree
        aria-label="Remote folders"
        className="max-h-full min-w-0 overflow-visible"
        disabledKeys={isDisabled ? nodes.keys() : []}
        expandedKeys={expandedKeys}
        items={roots}
        reduceMotion
        selectedKeys={new Set(path ? [path] : [])}
        selectionBehavior="replace"
        selectionMode="single"
        size="sm"
        onExpandedChange={(keys) => setExpandedKeys(new Set([...keys].map(String)))}
        onSelectionChange={(keys) => {
          if (isDisabled || keys === "all") return;
          const selected = [...keys][0];
          if (selected === undefined || String(selected) === path) return;
          const node = nodes.get(String(selected));
          if (node) onNavigate(node.id);
        }}
      >
        {function renderNode(node: FileTreeNode): React.JSX.Element {
          return (
            <FileTree.Item
              icon={({ isExpanded }) => <FontAwesomeIcon aria-hidden className="text-accent" icon={isExpanded ? faFolderOpen : faFolder} />}
              id={node.id}
              textValue={node.name}
              title={<span className="font-mono text-xs">{node.name}</span>}
            >
              {node.children.length > 0 ? <Collection items={node.children}>{renderNode}</Collection> : null}
            </FileTree.Item>
          );
        }}
      </FileTree>
    </div>
  );
}
