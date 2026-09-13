/** 访问口令认证卡片：由 .env 中的 REPORT_AUTH_TOKEN 触发。 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage, login } from "../api";
import { IconShieldCheck } from "./icons";

export function AuthCard({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = token.trim();
    if (!clean) return;

    setBusy(true);
    setError(null);
    try {
      await login(clean);
      onAuthenticated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm border-border p-6 shadow-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-brand/10 text-brand">
              <IconShieldCheck width={22} height={22} />
            </span>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">系统访问授权</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              当前环境已开启访问鉴权，请输入由管理员配置的访问口令。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="auth-token-input" className="text-xs font-medium text-foreground">
              访问口令
            </label>
            <input
              id="auth-token-input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="输入访问口令..."
              disabled={busy}
              autoFocus
              className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-brand/60 focus:ring-2 focus:ring-brand/20"
            />
          </div>

          {error ? (
            <p className="rounded-md bg-bad/10 p-2 text-xs font-medium text-bad">{error}</p>
          ) : null}

          <Button type="submit" size="default" disabled={busy || !token.trim()} className="w-full">
            {busy ? "验证中…" : "验证并进入"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
