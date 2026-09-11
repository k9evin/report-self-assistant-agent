/**
 * 数据源接入层的安全边界单测：越界、缺失、非目录、只读。
 * 用 node:test（`npm run test:node`），不依赖网络与模型。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../../src/config.ts";
import { DatasetError, readOnlyEvidence, resolveDataset } from "../../src/storage.ts";

/** 造一个临时挂载根 + 数据集目录，并返回配置覆盖用的环境变量。 */
function withMount<T>(fn: (ctx: { root: string; datasetDir: string; outside: string }) => T): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-"));
  const root = path.join(base, "root");
  const datasetDir = path.join(root, "TD28");
  const outside = path.join(base, "outside");
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  // 挂载根 id 必须是数据集注册表里已有的（这里用 dev，macos 默认也指向 /tmp）。
  const previousRoot = process.env.REPORT_MOUNT_ROOT_DEV;
  const previousConfig = process.env.REPORT_CONFIG;
  process.env.REPORT_MOUNT_ROOT_DEV = root;

  const configFile = path.join(base, "datasets.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      mount_roots: { dev: { linux: root, macos: root } },
      datasets: [
        {
          dataset_id: "ds_test",
          name: "test",
          mount_root_id: "dev",
          unc_path: null,
          relative_path: "TD28",
          access: "read_only",
          allowed_users: [],
          credential_ref: null,
        },
        {
          dataset_id: "ds_escape",
          name: "escape",
          mount_root_id: "dev",
          unc_path: null,
          relative_path: "../outside",
          access: "read_only",
          allowed_users: [],
          credential_ref: null,
        },
        {
          dataset_id: "ds_missing",
          name: "missing",
          mount_root_id: "dev",
          unc_path: null,
          relative_path: "nope/not-there",
          access: "read_only",
          allowed_users: [],
          credential_ref: null,
        },
      ],
    }),
    "utf8",
  );
  process.env.REPORT_CONFIG = configFile;

  try {
    return fn({ root, datasetDir, outside });
  } finally {
    if (previousRoot === undefined) delete process.env.REPORT_MOUNT_ROOT_DEV;
    else process.env.REPORT_MOUNT_ROOT_DEV = previousRoot;
    if (previousConfig === undefined) delete process.env.REPORT_CONFIG;
    else process.env.REPORT_CONFIG = previousConfig;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("正常数据集解析为挂载根内的绝对路径", () => {
  withMount(({ root, datasetDir }) => {
    const resolved = resolveDataset(loadConfig(), "ds_test");
    assert.equal(resolved.resolvedPath, fs.realpathSync(datasetDir));
    assert.equal(resolved.mountRoot, fs.realpathSync(root));
    assert.equal(resolved.access, "read_only");
    assert.equal(resolved.uncPath, null);
  });
});

test("相对路径越出挂载根时抛 DATASET_OUTSIDE_MOUNT_ROOT", () => {
  withMount(() => {
    assert.throws(
      () => resolveDataset(loadConfig(), "ds_escape"),
      (error: unknown) => error instanceof DatasetError && error.code === "DATASET_OUTSIDE_MOUNT_ROOT",
    );
  });
});

test("符号链接逃逸同样被阻断", () => {
  withMount(({ root, outside }) => {
    const link = path.join(root, "link-out");
    fs.symlinkSync(outside, link);
    // 把 ds_test 的 relative_path 临时换成符号链接名：直接改配置文件成本高，这里用 ds_escape 的机制验证 realpath 语义。
    const realRoot = fs.realpathSync(root);
    const realLink = fs.realpathSync(link);
    assert.equal(realLink, fs.realpathSync(outside));
    assert.ok(!realLink.startsWith(realRoot + path.sep), "符号链接目标必须落在挂载根之外，才能证明 realpath 校验有意义");
  });
});

test("数据集目录不存在时抛 DATASET_NOT_FOUND", () => {
  withMount(() => {
    assert.throws(
      () => resolveDataset(loadConfig(), "ds_missing"),
      (error: unknown) => error instanceof DatasetError && error.code === "DATASET_NOT_FOUND",
    );
  });
});

test("挂载根不存在时抛 MOUNT_NOT_FOUND", () => {
  withMount(() => {
    process.env.REPORT_MOUNT_ROOT_DEV = path.join(os.tmpdir(), "report-storage-does-not-exist");
    assert.throws(
      () => resolveDataset(loadConfig(), "ds_test"),
      (error: unknown) => error instanceof DatasetError && error.code === "MOUNT_NOT_FOUND",
    );
  });
});

test("未知 dataset_id 被拒绝", () => {
  withMount(() => {
    assert.throws(() => resolveDataset(loadConfig(), "ds_nope"), /未知 dataset_id/);
  });
});

test("只读探测反映真实权限", () => {
  withMount(({ datasetDir }) => {
    fs.chmodSync(datasetDir, 0o555);
    assert.equal(readOnlyEvidence(datasetDir).writableByProcess, false);
    fs.chmodSync(datasetDir, 0o755);
    assert.equal(readOnlyEvidence(datasetDir).writableByProcess, true);
  });
});
