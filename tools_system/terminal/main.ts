import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface ToolContext { db: any; tenantId: string; }

const execFileAsync = promisify(execFile);

/** 危险命令黑名单(直接拦截,不给模型尝试机会)。 */
const FORBIDDEN = [
	/^\s*(rm|rmdir|del|erase)\s+(-[a-zA-Z]+\s+)*(-?\/(s|f|r)\b)/i,
	/^\s*format\s/i,
	/^\s*mkfs/i,
	/^\s*dd\s/i,
	/^\s*shutdown|reboot|poweroff/i,
	/^\s*rm\s+-rf\s+\/$/i,
];

/** 终端工具:在当前机器执行命令并返回输出(只读类命令安全;危险命令黑名单拦截)。 */
export async function execute(_ctx: ToolContext, params: any) {
	const command = String(params?.command ?? "").trim();
	if (!command) return { content: [{ type: "text", text: "请提供要执行的命令。" }] };

	if (FORBIDDEN.some((re) => re.test(command))) {
		return { content: [{ type: "text", text: "[拦截] 该命令涉及危险操作(删除/格式化/关机等),已禁止执行。" }] };
	}

	// Windows 用 cmd,否则用 sh
	const shell = params?.shell ? String(params.shell) : process.platform === "win32" ? "cmd.exe" : "/bin/sh";
	const args = shell.endsWith("cmd.exe") ? ["/d", "/s", "/c", command] : ["-c", command];
	const timeoutMs = Math.min(Math.max(Number(params?.timeoutMs ?? 15000) || 15000, 1000), 60000);

	try {
		const { stdout, stderr } = await execFileAsync(shell, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
		const out = (stdout || "").toString();
		const err = (stderr || "").toString();
		return {
			content: [{ type: "text", text: out ? out.slice(0, 20000) : err ? err.slice(0, 20000) : "(无输出)" }],
			details: { exitCode: 0, stdoutLength: out.length, stderrLength: err.length, timedOut: false },
		};
	} catch (error) {
		const e = error as { code?: number | string; signal?: string; stdout?: Buffer; stderr?: Buffer; timedOut?: boolean; message?: string };
		return {
			content: [{ type: "text", text: (e.stdout?.toString() || "") + (e.stderr?.toString() || e.message || String(error)).slice(0, 20000) }],
			details: { exitCode: typeof e.code === "number" ? e.code : null, timedOut: e.timedOut === true, signal: e.signal ?? null },
		};
	}
}