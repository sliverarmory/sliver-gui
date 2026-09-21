import { useEffect, useMemo, useRef, useState } from "react";
import { FileTree } from "@heroui-pro/react";
import { Collection } from "react-aria-components/Collection";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFolder, faFolderOpen } from "@fortawesome/free-solid-svg-icons";

import type { SessionFileEntry } from "../../../shared/session-contracts";

interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  children: FileTreeNode[];
}

export interface SessionFileTreeSnapshot {
  path: string;
  breadcrumbs: ReadonlyArray<{ label: string; path: string }>;
  directories: readonly SessionFileEntry[];
}

interface SessionFileTreeProps {
  path: string;
  breadcrumbs: ReadonlyArray<{ label: string; path: string }>;
  snapshots: readonly SessionFileTreeSnapshot[];
  windows: boolean;
  isDisabled: boolean;
  onNavigate: (path: string) => void;
}

export function sessionFileTreePathKey(path: string, windows: boolean): string {
  if (!path) return "";
  if (!windows) {
    const trimmed = path.replace(/\/+$/u, "");
    return trimmed || "/";
  }

  const normalized = path.replaceAll("/", "\\");
  const trimmed = normalized.replace(/\\+$/u, "");
  if (!trimmed) return "\\";
  if (/^[A-Za-z]:$/u.test(trimmed)) return `${trimmed.toLowerCase()}\\`;
  return trimmed.toLowerCase();
}

export function SessionFileTree({ path, breadcrumbs, snapshots, windows, isDisabled, onNavigate }: SessionFileTreeProps): React.JSX.Element {
  const { roots, nodes, ancestry } = useMemo(() => {
    const nodeDetails = new Map<string, Omit<FileTreeNode, "children">>();
    const childIds = new Map<string, Set<string>>();
    const parentIds = new Map<string, string>();
    const authoritativePaths = new Set<string>();

    const ensureNode = (nodePath: string, name: string, authoritative = false): string => {
      const id = sessionFileTreePathKey(nodePath, windows);
      if (!id) return id;
      const existing = nodeDetails.get(id);
      if (!existing) nodeDetails.set(id, { id, name, path: nodePath });
      else if (authoritative || !authoritativePaths.has(id)) nodeDetails.set(id, { ...existing, name, path: nodePath });
      if (authoritative) authoritativePaths.add(id);
      return id;
    };

    const attachChild = (parentId: string, childId: string, authoritative: boolean): void => {
      if (!parentId || !childId || parentId === childId) return;
      const existingParent = parentIds.get(childId);
      if (existingParent === parentId) return;
      if (existingParent && !authoritative) return;

      let ancestorId: string | undefined = parentId;
      while (ancestorId) {
        if (ancestorId === childId) return;
        ancestorId = parentIds.get(ancestorId);
      }

      if (existingParent) childIds.get(existingParent)?.delete(childId);
      const children = childIds.get(parentId) ?? new Set<string>();
      children.add(childId);
      childIds.set(parentId, children);
      parentIds.set(childId, parentId);
    };

    const addBreadcrumbs = (
      snapshotPath: string,
      snapshotBreadcrumbs: ReadonlyArray<{ label: string; path: string }>,
    ): void => {
      let parentId = "";
      for (const [index, crumb] of snapshotBreadcrumbs.entries()) {
        // Breadcrumbs normalize separators for display; the listing owns the leaf's navigation path.
        const isLeaf = index === snapshotBreadcrumbs.length - 1;
        const id = ensureNode(isLeaf ? snapshotPath : crumb.path, crumb.label, isLeaf);
        if (!id) continue;
        attachChild(parentId, id, true);
        parentId = id;
      }
    };

    for (const snapshot of snapshots) addBreadcrumbs(snapshot.path, snapshot.breadcrumbs);
    addBreadcrumbs(path, breadcrumbs);

    for (const snapshot of snapshots) {
      const parentId = sessionFileTreePathKey(snapshot.path, windows);
      if (!parentId || !nodeDetails.has(parentId)) continue;
      const children = childIds.get(parentId) ?? new Set<string>();
      for (const directory of snapshot.directories) {
        if (!directory.isDirectory) continue;
        const id = ensureNode(directory.path, directory.name);
        if (!id) continue;
        attachChild(parentId, id, false);
      }
      if (!childIds.has(parentId)) childIds.set(parentId, children);
    }

    const nodes = new Map<string, FileTreeNode>();
    for (const details of nodeDetails.values()) nodes.set(details.id, { ...details, children: [] });
    for (const [parentId, children] of childIds) {
      const parent = nodes.get(parentId);
      if (!parent) continue;
      parent.children = [...children]
        .map((id) => nodes.get(id))
        .filter((node): node is FileTreeNode => node !== undefined)
        .sort(compareFileTreeNodes);
    }

    const roots = [...nodes.values()].filter((node) => !parentIds.has(node.id)).sort(compareFileTreeNodes);
    const ancestry = breadcrumbs.map((crumb, index) => sessionFileTreePathKey(
      index === breadcrumbs.length - 1 ? path : crumb.path,
      windows,
    )).filter((id) => id && nodes.has(id));
    return { roots, nodes, ancestry };
  }, [breadcrumbs, path, snapshots, windows]);

  const selectedPathKey = sessionFileTreePathKey(path, windows);

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
        disabledKeys={isDisabled ? [...nodes.keys()].filter((key) => key !== selectedPathKey) : []}
        expandedKeys={expandedKeys}
        items={roots}
        reduceMotion
        selectedKeys={new Set(selectedPathKey ? [selectedPathKey] : [])}
        selectionBehavior="replace"
        selectionMode="single"
        size="sm"
        onExpandedChange={(keys) => setExpandedKeys(new Set([...keys].map(String)))}
        onSelectionChange={(keys) => {
          if (isDisabled || keys === "all") return;
          const selected = [...keys][0];
          if (selected === undefined || String(selected) === selectedPathKey) return;
          const node = nodes.get(String(selected));
          if (node) onNavigate(node.path);
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

function compareFileTreeNodes(left: FileTreeNode, right: FileTreeNode): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}
