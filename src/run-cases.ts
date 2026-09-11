/**
 * 命令行跑测试案例集：`npm run cases` 跑全部，`npm run cases -- case-03-formula-overwrite` 跑指定用例。
 * 前端「测试案例」页签走的是同一个 runCase / evaluateCase，判定口径完全一致。
 */
import { runCasesByIds } from "./cases.ts";

const ok = await runCasesByIds(process.argv.slice(2));
process.exit(ok ? 0 : 1);
