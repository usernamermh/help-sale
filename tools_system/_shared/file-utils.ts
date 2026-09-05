import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 把相对仓库根(或仓库内绝对)路径解析为绝对路径;越出仓库根返回 null(安全拦截)。 */
export function resolveRepoPath(raw: string): string | null {
	if (!raw || typeof raw !== "string") return null;
	const p = path.resolve(REPO_ROOT, raw);
	if (p !== REPO_ROOT && !p.startsWith(REPO_ROOT + path.sep)) return null;
	return p;
}

export function repoRoot(): string {
	return REPO_ROOT;
}