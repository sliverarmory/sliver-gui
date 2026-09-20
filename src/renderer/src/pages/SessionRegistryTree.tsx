import { useEffect, useMemo, useState } from "react";
import { FileTree } from "@heroui-pro/react";
import { Collection } from "react-aria-components/Collection";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDesktop, faFolder, faFolderOpen } from "@fortawesome/free-solid-svg-icons";

import type { SessionRegistryHive } from "../../../shared/session-contracts";

export const REGISTRY_HIVE_LABELS: Record<SessionRegistryHive, string> = {
  HKCR: "HKEY_CLASSES_ROOT",
  HKCU: "HKEY_CURRENT_USER",
  HKLM: "HKEY_LOCAL_MACHINE",
  HKU: "HKEY_USERS",
  HKCC: "HKEY_CURRENT_CONFIG",
};

interface RegistryTreeNode {
  id: string;
  hive: SessionRegistryHive;
  path: string;
  name: string;
  children: RegistryTreeNode[];
}

interface SessionRegistryTreeProps {
  hive: SessionRegistryHive;
  path: string;
  branches: Array<{ hive: SessionRegistryHive; path: string; subkeys: string[] }>;
  onNavigate: (hive: SessionRegistryHive, path: string) => void;
}

export function SessionRegistryTree({ hive, path, branches, onNavigate }: SessionRegistryTreeProps): React.JSX.Element {
  const { roots, nodes, ancestry } = useMemo(() => {
    const nodes = new Map<string, RegistryTreeNode>();
    const roots = (Object.keys(REGISTRY_HIVE_LABELS) as SessionRegistryHive[]).map((rootHive) => {
      const root: RegistryTreeNode = {
        id: registryTreeId(rootHive, ""),
        hive: rootHive,
        path: "",
        name: REGISTRY_HIVE_LABELS[rootHive],
        children: [],
      };
      nodes.set(root.id, root);
      return root;
    });

    const ensurePath = (nodeHive: SessionRegistryHive, nodePath: string): RegistryTreeNode => {
      let parent = nodes.get(registryTreeId(nodeHive, ""))!;
      for (const name of nodePath.split("\\").filter(Boolean)) {
        const childPath = parent.path ? `${parent.path}\\${name}` : name;
        const id = registryTreeId(nodeHive, childPath);
        let child = nodes.get(id);
        if (!child) {
          child = { id, hive: nodeHive, path: childPath, name, children: [] };
          parent.children.push(child);
          nodes.set(id, child);
        }
        parent = child;
      }
      return parent;
    };

    for (const branch of branches) {
      const parent = ensurePath(branch.hive, branch.path);
      for (const subkey of branch.subkeys) {
        ensurePath(branch.hive, parent.path ? `${parent.path}\\${subkey}` : subkey);
      }
    }
    ensurePath(hive, path);
    for (const node of nodes.values()) {
      node.children.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    }

    const ancestry = [registryTreeId(hive, "")];
    let ancestorPath = "";
    for (const name of path.split("\\").filter(Boolean)) {
      ancestorPath = ancestorPath ? `${ancestorPath}\\${name}` : name;
      ancestry.push(registryTreeId(hive, ancestorPath));
    }
    return { roots, nodes, ancestry };
  }, [branches, hive, path]);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set(ancestry));
  const selectedId = registryTreeId(hive, path);

  useEffect(() => {
    setExpandedKeys((current) => {
      if (ancestry.every((id) => current.has(id))) return current;
      return new Set([...current, ...ancestry]);
    });
  }, [ancestry]);

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-foreground">
        <FontAwesomeIcon aria-hidden className="text-muted" icon={faDesktop} />
        <span>Computer</span>
      </div>
      <FileTree
        aria-label="Registry keys"
        className="max-h-full min-w-0 overflow-visible"
        expandedKeys={expandedKeys}
        items={roots}
        reduceMotion
        selectedKeys={new Set([selectedId])}
        selectionBehavior="replace"
        selectionMode="single"
        size="sm"
        onExpandedChange={(keys) => setExpandedKeys(new Set([...keys].map(String)))}
        onSelectionChange={(keys) => {
          if (keys === "all") return;
          const selected = [...keys][0];
          if (selected === undefined || String(selected) === selectedId) return;
          const node = nodes.get(String(selected));
          if (node) onNavigate(node.hive, node.path);
        }}
      >
        {function renderNode(node: RegistryTreeNode): React.JSX.Element {
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

function registryTreeId(hive: SessionRegistryHive, path: string): string {
  return `${hive}\\${path.split("\\").filter(Boolean).join("\\").toLowerCase()}`;
}
