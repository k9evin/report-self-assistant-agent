/** 主题：<html> 上的 dark class + localStorage 记忆，首次跟随 prefers-color-scheme。 */
export type Theme = "light" | "dark";

const STORAGE_KEY = "report-agent-theme";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* localStorage 不可用时跟随系统 */
  }
  return systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* 记忆失败不影响本次切换 */
  }
}
