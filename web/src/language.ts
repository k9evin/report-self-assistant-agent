export type ResponseLanguage = "auto" | "zh" | "en";

const KEY = "report.responseLanguage";

export function readResponseLanguage(): ResponseLanguage {
  if (typeof window === "undefined") return "auto";
  const value = window.localStorage.getItem(KEY);
  return value === "zh" || value === "en" || value === "auto" ? value : "auto";
}

export function saveResponseLanguage(language: ResponseLanguage): void {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, language);
}
