/**
 * 数据源接入层（PRD §18.5 / §26.3）：dataset_id → 只读本地路径。
 *
 * 这是"Agent 拿不到宿主机路径"的关键一环：Agent 只给 dataset_id，映射与越界校验在这里完成；
 * 解析结果必须落在挂载根内（realpath 之后判断，阻断 ../ 与符号链接逃逸）。
 */
import fs from "node:fs";
import path from "node:path";

import { getDataset, getMountRoot, type AppConfig, type DatasetRecord, type MountRootConfig } from "./config.ts";

export interface ResolvedDataset {
  datasetId: string;
  name: string;
  mountRootId: string;
  mountRoot: string;
  resolvedPath: string;
  uncPath: string | null;
  access: "read_only";
  record: DatasetRecord;
  mountRootConfig: MountRootConfig;
}

export interface DirectoryEntry {
  name: string;
  relative_path: string;
}

export class DatasetError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DatasetError";
    this.code = code;
    this.details = details;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * 校验并解析数据集为只读本地路径。任何越界、缺失、不可读都在这里被拦下。
 */
export function resolveDataset(config: AppConfig, datasetId: string): ResolvedDataset {
  const record = getDataset(config, datasetId);
  const rootConfig = getMountRoot(config, record.mount_root_id);
  const root = rootConfig.resolvedRoot;

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new DatasetError("MOUNT_NOT_FOUND", `挂载根不可用: ${root}`, {
      mount_root_id: rootConfig.id,
      mount_root: root,
      hint: "检查 /mnt 挂载或设置 REPORT_MOUNT_ROOT_<ID>",
    });
  }

  const candidate = path.resolve(root, record.relative_path ?? "");
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new DatasetError("DATASET_NOT_FOUND", `数据集路径不存在: ${candidate}`, {
      dataset_id: datasetId,
      resolved_path: candidate,
    });
  }

  if (!isInside(realCandidate, realRoot)) {
    throw new DatasetError("DATASET_OUTSIDE_MOUNT_ROOT", "数据集路径越出挂载根，已拒绝", {
      dataset_id: datasetId,
      resolved_path: realCandidate,
      mount_root: realRoot,
    });
  }

  if (!fs.statSync(realCandidate).isDirectory()) {
    throw new DatasetError("DATASET_NOT_DIRECTORY", `数据集路径不是目录: ${realCandidate}`, {
      dataset_id: datasetId,
    });
  }

  try {
    fs.accessSync(realCandidate, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new DatasetError("DATASET_NOT_READABLE", `数据集不可读: ${realCandidate}`, {
      dataset_id: datasetId,
    });
  }

  return {
    datasetId,
    name: record.name,
    mountRootId: rootConfig.id,
    mountRoot: realRoot,
    resolvedPath: realCandidate,
    uncPath: record.unc_path,
    access: "read_only",
    record,
    mountRootConfig: rootConfig,
  };
}

/** 解析用户选择的挂载根内目录；不接收绝对路径，也不改动配置或源目录。 */
export function resolveDirectoryDataset(config: AppConfig, mountRootId: string, relativePath = ""): ResolvedDataset {
  if (path.isAbsolute(relativePath)) {
    throw new DatasetError("DATASET_OUTSIDE_MOUNT_ROOT", "数据集路径必须相对于挂载根", { mount_root_id: mountRootId });
  }
  const rootConfig = getMountRoot(config, mountRootId);
  const root = rootConfig.resolvedRoot;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new DatasetError("MOUNT_NOT_FOUND", `挂载根不可用: ${root}`, { mount_root_id: mountRootId });
  }
  const candidate = path.resolve(root, relativePath || ".");
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new DatasetError("DATASET_NOT_FOUND", `数据集路径不存在: ${candidate}`, { mount_root_id: mountRootId, relative_path: relativePath });
  }
  if (!isInside(realCandidate, realRoot)) {
    throw new DatasetError("DATASET_OUTSIDE_MOUNT_ROOT", "数据集路径越出挂载根，已拒绝", { mount_root_id: mountRootId });
  }
  if (!fs.statSync(realCandidate).isDirectory()) {
    throw new DatasetError("DATASET_NOT_DIRECTORY", `数据集路径不是目录: ${relativePath}`, { mount_root_id: mountRootId });
  }
  try {
    fs.accessSync(realCandidate, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new DatasetError("DATASET_NOT_READABLE", `数据集不可读: ${relativePath}`, { mount_root_id: mountRootId });
  }
  const normalized = path.relative(realRoot, realCandidate);
  return {
    datasetId: `dir:${mountRootId}:${normalized || "."}`,
    name: normalized || mountRootId,
    mountRootId,
    mountRoot: realRoot,
    resolvedPath: realCandidate,
    uncPath: null,
    access: "read_only",
    record: { dataset_id: `dir:${mountRootId}:${normalized || "."}`, name: normalized || mountRootId, mount_root_id: mountRootId, unc_path: null, relative_path: normalized, access: "read_only", allowed_users: [], credential_ref: null },
    mountRootConfig: rootConfig,
  };
}

/** 列出当前层的直接子目录；符号链接逃逸和不可读目录不返回。 */
export function listDatasetDirectories(config: AppConfig, mountRootId: string, relativePath = ""): DirectoryEntry[] {
  const current = resolveDirectoryDataset(config, mountRootId, relativePath);
  return fs.readdirSync(current.resolvedPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const childRelative = path.relative(current.mountRoot, path.join(current.resolvedPath, entry.name));
      try {
        resolveDirectoryDataset(config, mountRootId, childRelative);
        return [{ name: entry.name, relative_path: childRelative }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 该挂载是否真的只读（作为审计证据，不改变读写行为）。 */
export function readOnlyEvidence(resolvedPath: string): { writableByProcess: boolean } {
  try {
    fs.accessSync(resolvedPath, fs.constants.W_OK);
    return { writableByProcess: true };
  } catch {
    return { writableByProcess: false };
  }
}
