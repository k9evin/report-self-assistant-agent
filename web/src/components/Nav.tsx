/** 顶部导航：品牌标记、页签、主题切换。 */
import type { Theme } from "../theme";
import { IconMoon, IconSun } from "./icons";

export type TabKey = "run" | "cases";

const TABS: { key: TabKey; label: string }[] = [
  { key: "run", label: "运行任务" },
  { key: "cases", label: "测试案例" },
];

export function Nav({
  tab,
  onChangeTab,
  theme,
  onToggleTheme,
}: {
  tab: TabKey;
  onChangeTab: (tab: TabKey) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path d="M8 9h8M8 12.5h8M8 16h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-name">自动化测试报告智能助理</span>
        </div>

        <nav className="tabs" aria-label="主导航">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`tab ${tab === entry.key ? "tab-active" : ""}`}
              aria-current={tab === entry.key ? "page" : undefined}
              onClick={() => onChangeTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="btn btn-icon btn-secondary"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
