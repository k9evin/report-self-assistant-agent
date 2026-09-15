import { useEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps, type TreeApi } from "react-arborist";

import type { DirectoryEntry, MountRoot } from "../types";

type TreeNode = {
  id: string;
  name: string;
  mountRootId: string;
  relativePath: string;
  loaded: boolean;
  children: TreeNode[];
};

function makeRoot(root: MountRoot): TreeNode {
  return { id: `root:${root.mount_root_id}`, name: root.mount_root_id, mountRootId: root.mount_root_id, relativePath: "", loaded: false, children: [] };
}

function replaceNode(nodes: TreeNode[], id: string, update: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => node.id === id ? update(node) : { ...node, children: replaceNode(node.children, id, update) });
}

export function DirectoryTreeSelect({
  roots,
  fetchChildren,
  disabled,
  onSelect,
}: {
  roots: MountRoot[];
  fetchChildren: (mountRootId: string, relativePath: string) => Promise<DirectoryEntry[]>;
  disabled?: boolean;
  onSelect: (selection: { mountRootId: string; relativePath: string; label: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<TreeNode>>(null);

  useEffect(() => setNodes(roots.filter((root) => root.available).map(makeRoot)), [roots]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const load = async (data: TreeNode) => {
    if (data.loaded) return;
    const entries = await fetchChildren(data.mountRootId, data.relativePath);
    setNodes((previous) => replaceNode(previous, data.id, (current) => ({
      ...current,
      loaded: true,
      children: entries.map((entry) => ({ id: `${data.mountRootId}:${entry.relative_path}`, name: entry.name, mountRootId: data.mountRootId, relativePath: entry.relative_path, loaded: false, children: [] })),
    })));
    requestAnimationFrame(() => treeRef.current?.open(data.id));
  };

  const label = (() => {
    const find = (items: TreeNode[]): TreeNode | undefined => items.flatMap((node) => [node, ...findAll(node.children)]).find((node) => node.id === selectedId);
    const findAll = (items: TreeNode[]): TreeNode[] => items.flatMap((node) => [node, ...findAll(node.children)]);
    const node = find(nodes);
    return node?.relativePath || "选择服务器目录";
  })();

  function Node({ node, style }: NodeRendererProps<TreeNode>) {
    const data = node.data;
    return (
      <div style={style} className={`flex items-center gap-1 rounded px-1 text-xs hover:bg-muted ${selectedId === data.id ? "bg-brand/10 text-brand" : ""}`}>
        <button type="button" className="grid size-5 place-items-center text-muted-foreground" aria-label={node.isOpen ? "折叠目录" : "展开目录"} onClick={() => { if (data.loaded) node.toggle(); else void load(data); }}>
          {node.isOpen ? "⌄" : "›"}
        </button>
        <button type="button" className="min-w-0 flex-1 truncate py-1.5 text-left" onClick={() => {
          if (!data.relativePath) return;
          setSelectedId(data.id);
          onSelect({ mountRootId: data.mountRootId, relativePath: data.relativePath, label: data.relativePath });
          setOpen(false);
        }}>{data.name}</button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative min-w-52">
      <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg border border-border bg-card px-3 text-left text-xs disabled:opacity-50" disabled={disabled} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="truncate">{label}</span><span className="text-muted-foreground">⌄</span>
      </button>
      {open ? <div className="absolute z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-1 shadow-lg">
        <Tree ref={treeRef} data={nodes} width="100%" height={280} indent={16} rowHeight={28} openByDefault={false} selection={selectedId} aria-label="服务器目录选择器">
          {Node}
        </Tree>
      </div> : null}
    </div>
  );
}
