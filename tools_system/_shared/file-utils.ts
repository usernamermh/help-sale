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

/** 工具上下文里可覆盖的文件策略(测试/嵌入式用;线上由 config 决定) */
export interface FileScopeOverride {
	tenantScoped?: boolean;
	tenantRootDir?: string;
	allowOutsideRepo?: boolean;
}

/** 由工具上下文算出文件策略:默认取配置,上下文的 fileScope 只用于覆盖单项。 */
export function fileScopeFor(
	ctx: { tenantId?: string; fileScope?: FileScopeOverride } | undefined,
	defaults: { tenantScoped: boolean; tenantRootDir: string; allowOutsideRepo: boolean },
): FileScope {
	const override = ctx?.fileScope;
	return {
		tenantId: String(ctx?.tenantId ?? ""),
		tenantScoped: override?.tenantScoped ?? defaults.tenantScoped,
		tenantRootDir: override?.tenantRootDir ?? defaults.tenantRootDir,
		allowOutsideRepo: override?.allowOutsideRepo ?? defaults.allowOutsideRepo,
	};
}

export function repoRoot(): string {
	return REPO_ROOT;
}

export interface FileScope {
	/** 当前租户(文件按租户分目录时是目录名的一部分) */
	tenantId: string;
	/** 是否按租户隔离目录(tools.files.tenantScoped) */
	tenantScoped: boolean;
	/** 租户文件根目录(tools.files.tenantRootDir),相对仓库根或绝对路径 */
	tenantRootDir: string;
	/** 是否允许写到仓库之外(tools.fileWrite.allowOutsideRepo) */
	allowOutsideRepo: boolean;
}

/** 租户目录名:只保留安全字符,避免 tenantId 里出现路径分隔符导致越界。 */
export function tenantDirName(tenantId: string): string {
	const safe = String(tenantId ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
	return safe || "_anonymous";
}

/** 租户文件根(绝对路径)。 */
export function tenantRoot(scope: FileScope): string {
	const base = path.isAbsolute(scope.tenantRootDir) ? scope.tenantRootDir : path.join(REPO_ROOT, scope.tenantRootDir);
	return path.join(base, tenantDirName(scope.tenantId));
}

/**
 * 工具侧统一的路径策略(读与写共用):
 *   1) tenantScoped=true:只允许访问 <tenantRootDir>/<tenantId>/ 之内 —— 租户之间物理隔离;
 *   2) allowOutsideRepo=true:允许任意本地路径(开发/单机场景);
 *   3) 其它:只允许仓库内路径。
 */
export function resolveToolPath(raw: string, scope: FileScope): { path?: string; error?: string } {
	if (!raw || typeof raw !== "string") return { error: "路径为空。" };
	if (scope.tenantScoped) {
		const root = tenantRoot(scope);
		const target = path.resolve(root, raw);
		if (target === root || target.startsWith(root + path.sep)) return { path: target };
		return { error: `路径超出本租户目录(tools.files.tenantScoped=true):${target}` };
	}
	// 相对路径一律按仓库根解析(与 file_read/txt 的历史语义一致),绝对路径原样使用
	const target = path.resolve(REPO_ROOT, raw);
	if (scope.allowOutsideRepo) return { path: target };
	if (target === REPO_ROOT || target.startsWith(REPO_ROOT + path.sep)) return { path: target };
	return { error: `路径超出仓库范围(tools.fileWrite.allowOutsideRepo=false):${target}` };
}