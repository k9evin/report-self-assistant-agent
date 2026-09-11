/** 应用外壳：单页应用，两个页签用 useState 切换（不引入路由库）。 */
import { useCallback, useEffect, useState } from "react";

import { CasesTab } from "./components/CasesTab";
import { Nav } from "./components/Nav";
import type { TabKey } from "./components/Nav";
import { RunTab } from "./components/RunTab";
import { applyTheme, readTheme } from "./theme";
import type { Theme } from "./theme";

export function App() {
  const [tab, setTab] = useState<TabKey>("run");
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <div className="app">
      <Nav tab={tab} onChangeTab={setTab} theme={theme} onToggleTheme={toggleTheme} />
      <main className="main">
        <div className="main-inner">
          {tab === "run" ? <RunTab /> : <CasesTab />}
          <footer className="foot caption">
            自动化测试报告智能助理 · 所有请求都走同源的 /api，不加载任何外部资源
          </footer>
        </div>
      </main>
    </div>
  );
}
