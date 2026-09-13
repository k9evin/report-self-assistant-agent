/** 应用运行模式：上线业务模式 (prod) vs 开发者模式 (dev)。 */
export type AppMode = "prod" | "dev";

const STORAGE_KEY = "report-agent-app-mode";

export function readAppMode(): AppMode {
  try {
    const search = window.location.search;
    if (search.includes("dev=1") || search.includes("mode=dev")) {
      return "dev";
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dev" || saved === "prod") return saved;
  } catch {
    /* localStorage 不可用时默认 prod */
  }
  return "prod";
}

export function saveAppMode(mode: AppMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 记忆失败不影响本次切换 */
  }
}
