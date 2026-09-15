import { useEffect, useRef, useState } from "react";

import type { DirectoryEntry, MountRoot } from "../types";

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
  const [mountRootId, setMountRootId] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedRoot = roots.find((root) => root.mount_root_id === mountRootId);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const navigate = async (rootId: string, relativePath: string) => {
    setLoading(true);
    try {
      const next = await fetchChildren(rootId, relativePath);
      setMountRootId(rootId);
      setPath(relativePath);
      setEntries(next);
      onSelect(relativePath ? { mountRootId: rootId, relativePath, label: relativePath } : null);
    } finally {
      setLoading(false);
    }
  };

  const back = () => {
    if (!mountRootId) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!path) {
      setMountRootId("");
      setEntries([]);
      onSelect(null);
    } else {
      void navigate(mountRootId, parent);
    }
  };

  const label = path || "选择服务器目录";

  return (
    <div ref={rootRef} className="relative min-w-52">
      <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg border border-border bg-card px-3 text-left text-xs disabled:opacity-50" disabled={disabled} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="truncate">{label}</span><span className="text-muted-foreground">⌄</span>
      </button>
      {open ? <div className="absolute z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-1 shadow-lg">
        {mountRootId ? <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
          <button type="button" className="text-brand hover:underline" onClick={back}>← 返回上级</button>
          <span className="truncate text-muted-foreground">{selectedRoot?.mount_root_id}{path ? ` / ${path}` : ""}</span>
        </div> : <div className="border-b border-border px-2 py-1.5 text-xs text-muted-foreground">选择服务器目录入口</div>}
        <div className="max-h-70 overflow-auto py-1">
          {mountRootId ? (loading ? <div className="px-2 py-2 text-xs text-muted-foreground">正在读取目录…</div> : entries.length ? entries.map((entry) => (
            <button key={entry.relative_path} type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void navigate(mountRootId, entry.relative_path)}>
              <span className="truncate">{entry.name}</span><span className="text-muted-foreground">›</span>
            </button>
          )) : <div className="px-2 py-2 text-xs text-muted-foreground">此目录没有子目录</div>) : roots.filter((root) => root.available).map((root) => (
            <button key={root.mount_root_id} type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void navigate(root.mount_root_id, "")}>
              <span className="truncate">{root.mount_root_id}</span><span className="text-muted-foreground">›</span>
            </button>
          ))}
        </div>
      </div> : null}
    </div>
  );
}
