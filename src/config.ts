/**
 * 运行配置：项目路径、数据集注册表、挂载根解析、任务工作目录、模型选择。
 * 一切以项目内文件 + 环境变量为准，不读取任何全局 ~/.penguin 配置。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface MountRootConfig {
  id: string;
  unc: string | null;
  credentialRef: string | null;
  /** 当前平台实际生效的挂载根（只读）。 */
  resolvedRoot: string;
  resolvedFrom: "env-dataset-root" | "env-global" | "platform-default";
}

export interface DatasetRecord {
  dataset_id: string;
  name: string;
  mount_root_id: string;
  unc_path: string | null;
  relative_path: string;
  access: "read_only";
  allowed_users: string[];
  credential_ref: string | null;
}

export interface AppConfig {
  projectRoot: string;
  configPath: string;
  workDir: string;
  toolsScript: string;
  pythonBin: string;
  personaPath: string;
  skillsDir: string;
  agentDir: string;
  modelsPath: string;
  authPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  devModeAllowed: boolean;
  authToken: string | null;
  mountRoots: Map<string, MountRootConfig>;
  datasets: Map<string, DatasetRecord>;
}

/** config/datasets.json 里 mount_roots.<id> 的原始形态（各平台一个默认挂载点）。 */
interface MountRootEntry {
  unc?: string | null;
  linux?: string;
  macos?: string;
  windows?: string;
  credential_ref?: string | null;
}

interface RawConfig {
  mount_roots?: Record<string, MountRootEntry>;
  datasets?: DatasetRecord[];
}

/** 极简 .env 读取：已存在的环境变量优先，绝不覆盖。 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function platformDefault(entry: MountRootEntry): string | null {
  switch (os.platform()) {
    case "linux":
      return entry.linux ?? null;
    case "darwin":
      return entry.macos ?? entry.linux ?? null;
    case "win32":
      return entry.windows ?? null;
    default:
      return entry.linux ?? null;
  }
}

export function loadConfig(overrides: Partial<Pick<AppConfig, "provider" | "modelId">> = {}): AppConfig {
  const projectRoot = PROJECT_ROOT;
  loadDotEnv(path.join(projectRoot, ".env"));

  const configPath = process.env.REPORT_CONFIG
    ? path.resolve(process.env.REPORT_CONFIG)
    : path.join(projectRoot, "config", "datasets.json");
  if (!fs.existsSync(configPath)) throw new Error(`数据集配置不存在: ${configPath}`);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawConfig;

  const mountRoots = new Map<string, MountRootConfig>();
  for (const [id, entry] of Object.entries(raw.mount_roots ?? {})) {
    const envKey = `REPORT_MOUNT_ROOT_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const perRoot = process.env[envKey];
    const global = process.env.REPORT_MOUNT_ROOT;
    const fallback = platformDefault(entry);
    const resolvedRoot = perRoot ?? global ?? fallback;
    if (!resolvedRoot) {
      throw new Error(
        `挂载根 ${id} 在当前平台没有默认路径，请设置 ${envKey} 或 REPORT_MOUNT_ROOT`,
      );
    }
    mountRoots.set(id, {
      id,
      unc: entry.unc ?? null,
      credentialRef: entry.credential_ref ?? null,
      resolvedRoot: path.resolve(resolvedRoot),
      resolvedFrom: perRoot ? "env-dataset-root" : global ? "env-global" : "platform-default",
    });
  }

  const datasets = new Map<string, DatasetRecord>();
  for (const record of raw.datasets ?? []) {
    if (!mountRoots.has(record.mount_root_id)) {
      throw new Error(`数据集 ${record.dataset_id} 引用了未知挂载根 ${record.mount_root_id}`);
    }
    datasets.set(record.dataset_id, {
      ...record,
      access: "read_only",
      allowed_users: record.allowed_users ?? [],
    });
  }

  const agentDir = path.join(projectRoot, ".pi", "agent");
  return {
    projectRoot,
    configPath,
    workDir: path.resolve(process.env.REPORT_WORK_DIR ?? path.join(projectRoot, "work")),
    toolsScript: path.join(projectRoot, "tools", "report_tools.py"),
    pythonBin: process.env.REPORT_PYTHON ?? process.env.PYTHON ?? "python3",
    personaPath: path.join(projectRoot, "persona.md"),
    skillsDir: path.join(projectRoot, ".agents", "skills"),
    agentDir,
    modelsPath: path.join(agentDir, "models.json"),
    authPath: path.join(agentDir, "auth.json"),
    provider: overrides.provider ?? process.env.REPORT_PROVIDER ?? "deepseek",
    modelId: overrides.modelId ?? process.env.REPORT_MODEL_ID ?? "deepseek-v4-pro",
    thinkingLevel: process.env.REPORT_THINKING_LEVEL ?? "medium",
    devModeAllowed:
      process.env.REPORT_DEV_MODE !== undefined
        ? process.env.REPORT_DEV_MODE !== "false" &&
          process.env.REPORT_DEV_MODE !== "0" &&
          process.env.REPORT_DEV_MODE !== "off"
        : process.env.NODE_ENV !== "production",
    authToken: (process.env.REPORT_AUTH_TOKEN ?? process.env.REPORT_AUTH_PASSWORD ?? "").trim() || null,
    mountRoots,
    datasets,
  };
}

export function getDataset(config: AppConfig, datasetId: string): DatasetRecord {
  const dataset = config.datasets.get(datasetId);
  if (!dataset) {
    const known = [...config.datasets.keys()].join(", ") || "(none)";
    throw new Error(`未知 dataset_id: ${datasetId}（可用: ${known}）`);
  }
  if (dataset.access !== "read_only") {
    throw new Error(`数据集 ${datasetId} 的访问方式必须是 read_only`);
  }
  return dataset;
}

export function getMountRoot(config: AppConfig, mountRootId: string): MountRootConfig {
  const root = config.mountRoots.get(mountRootId);
  if (!root) throw new Error(`未知 mount_root_id: ${mountRootId}`);
  return root;
}
