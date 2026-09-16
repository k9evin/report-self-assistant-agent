/** 应用外壳：主导航、历史对话侧栏与运行/案例页签，联动后端 .env 鉴权与开发模式判断。 */
import { useCallback, useEffect, useState } from "react";

import { fetchHealth, logout } from "./api";
import { AuthCard } from "./components/AuthCard";
import { CasesTab } from "./components/CasesTab";
import { HistorySidebar } from "./components/HistorySidebar";
import { Nav } from "./components/Nav";
import type { TabKey } from "./components/Nav";
import { RunTab } from "./components/RunTab";
import { readResponseLanguage, saveResponseLanguage } from "./language";
import type { ResponseLanguage } from "./language";
import { readAppMode, saveAppMode } from "./mode";
import type { AppMode } from "./mode";
import { applyTheme, readTheme } from "./theme";
import type { Theme } from "./theme";

function getSessionIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!path || path === "cases" || path.startsWith("assets/") || path.includes(".")) {
    return null;
  }
  return decodeURIComponent(path);
}

function getInitialTab(): TabKey {
  if (typeof window === "undefined") return "run";
  const path = window.location.pathname.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  return path === "cases" ? "cases" : "run";
}

export function App() {
  const [tab, setTab] = useState<TabKey>(() => getInitialTab());
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [responseLanguage, setResponseLanguage] = useState<ResponseLanguage>(() => readResponseLanguage());
  const [mode, setMode] = useState<AppMode>(() => readAppMode());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => getSessionIdFromPath());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 后端 .env 状态：dev_mode_allowed (REPORT_DEV_MODE) 与 auth_required (REPORT_AUTH_TOKEN)
  const [devModeAllowed, setDevModeAllowed] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(true);

  // 监听浏览器前进/后退 (popstate)
  useEffect(() => {
    const handlePopState = () => {
      const initialTab = getInitialTab();
      setTab(initialTab);
      const sid = getSessionIdFromPath();
      setSelectedRunId(sid);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const health = await fetchHealth();
      const allowed = health.dev_mode_allowed !== false;
      setDevModeAllowed(allowed);
      setAuthRequired(Boolean(health.auth_required));
      setAuthenticated(health.authenticated !== false);

      // 上线环境如果由 .env 关闭了开发模式，强制退回到 prod
      if (!allowed) {
        setMode("prod");
        saveAppMode("prod");
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((current) => (current === "dark" ? "light" : "dark")),
    [],
  );

  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((current) => !current),
    [],
  );

  const handleResponseLanguageChange = useCallback((language: ResponseLanguage) => {
    setResponseLanguage(language);
    saveResponseLanguage(language);
  }, []);

  const handleTabChange = useCallback(
    (newTab: TabKey) => {
      setTab(newTab);
      if (newTab === "cases") {
        if (window.location.pathname !== "/cases") {
          window.history.pushState(null, "", "/cases");
        }
      } else {
        const targetPath = selectedRunId ? `/${encodeURIComponent(selectedRunId)}` : "/";
        if (window.location.pathname !== targetPath) {
          window.history.pushState(null, "", targetPath);
        }
      }
    },
    [selectedRunId],
  );

  const handleModeChange = useCallback(
    (newMode: AppMode) => {
      // 若后端 .env 禁止开发模式，一律锁定为 prod
      if (!devModeAllowed && newMode === "dev") return;
      setMode(newMode);
      saveAppMode(newMode);
      if (newMode === "prod" && tab === "cases") {
        setTab("run");
        const targetPath = selectedRunId ? `/${encodeURIComponent(selectedRunId)}` : "/";
        if (window.location.pathname !== targetPath) {
          window.history.pushState(null, "", targetPath);
        }
      }
    },
    [devModeAllowed, selectedRunId, tab],
  );

  const handleLogout = useCallback(async () => {
    await logout();
    await checkHealth();
  }, [checkHealth]);

  const startNew = useCallback(() => {
    setSelectedRunId(null);
    setTab("run");
    if (window.location.pathname !== "/") {
      window.history.pushState(null, "", "/");
    }
  }, []);

  const handleSelectRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setTab("run");
    const targetPath = `/${encodeURIComponent(runId)}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
  }, []);

  const handleRunCreated = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setTab("run");
    const targetPath = `/${encodeURIComponent(runId)}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
  }, []);

  return (
    <div className="app">
      <Nav
        tab={tab}
        onChangeTab={handleTabChange}
        theme={theme}
        onToggleTheme={toggleTheme}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        mode={mode}
        onModeChange={handleModeChange}
        devModeAllowed={devModeAllowed}
        authRequired={authRequired}
        onLogout={handleLogout}
        responseLanguage={responseLanguage}
        onResponseLanguageChange={handleResponseLanguageChange}
      />

      {/* 若 .env 启用了访问鉴权且未通过验证，展示登录卡片阻断主流程 */}
      {authRequired && !authenticated ? (
        <main className="main flex flex-1 items-center justify-center">
          <AuthCard onAuthenticated={checkHealth} />
        </main>
      ) : (
        <div className="workspace-shell">
          <HistorySidebar
            activeRunId={selectedRunId}
            onSelect={handleSelectRun}
            onNew={startNew}
            collapsed={sidebarCollapsed}
            mode={mode}
          />
          <main className="main">
            <div className="main-inner">
              {tab === "run" ? (
                <RunTab
                  selectedRunId={selectedRunId}
                  mode={mode}
                  onRunCreated={handleRunCreated}
                  onNewSession={startNew}
                  responseLanguage={responseLanguage}
                />
              ) : devModeAllowed && mode === "dev" ? (
                <CasesTab />
              ) : (
                <RunTab
                  selectedRunId={selectedRunId}
                  mode={mode}
                  onRunCreated={handleRunCreated}
                  onNewSession={startNew}
                  responseLanguage={responseLanguage}
                />
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
