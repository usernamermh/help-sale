import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../backend/env.js";
import { repoRoot } from "../_shared/file-utils.js";

/**
 * 通用文件写入工具(替代原来"只允许新建文件"的 file_write_new)。
 *
 *   op=create   新建文件:文件已存在则拒绝,并提示改用 replace(带读到的 hash)
 *   op=replace  整文件替换:必须带 expectedHash;哈希对不上说明文件被改过 → 拒绝并回当前哈希
 *   op=patch    按行号局部修改:必须带 expectedHash + edits[];每条 edit 可再带 expect(该区间的原文),
 *               工具做"哈希 + 行号 + 原文"三重校验,避免模型数错行把内容写到错位置
 *
 * 约定:行号从 1 开始;endLine 省略 = 只改一行;content="" = 删除该区间;
 *       写入保留原文件的换行风格(CRLF/LF)与 BOM;原子写(同目录临时文件 + rename)。
 */

interface ToolContext { db: unknown; tenantId: string; }

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const HASH_ID_LEN = 12;
const MIN_HASH_INPUT = 8;

interface EditInput { startLine?: number; endLine?: number; content?: string; expect?: string }

interface TextFile {
	hash: string;
	id: string;
	text: string;
	bom: boolean;
	eol: "\n" | "\r\n";
	endsWithNewline: boolean;
	lines: string[];
}

const ok = (text: string, details?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details: details ?? null });
const fail = (text: string, details?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details: { ...(details ?? {}), ok: false } });

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function detectEol(text: string): "\n" | "\r\n" {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? "\r\n" : "\n";
}

function loadText(file: string): TextFile {
	const raw = readFileSync(file);
	if (raw.includes(0)) throw new Error("BINARY");
	let text = raw.toString("utf8");
	const bom = text.charCodeAt(0) === 0xfeff;
	if (bom) text = text.slice(1);
	const eol = detectEol(text);
	const endsWithNewline = text.endsWith("\n");
	const body = endsWithNewline ? text.replace(/\r?\n$/, "") : text;
	const lines = text.length === 0 ? [] : body.split(/\r?\n/);
	const hash = sha256(raw);
	return { hash, id: hash.slice(0, HASH_ID_LEN), text, bom, eol, endsWithNewline, lines };
}

function render(lines: string[], eol: string, endsWithNewline: boolean, bom: boolean): string {
	const body = lines.join(eol);
	const tail = lines.length > 0 && endsWithNewline ? body + eol : body;
	return (bom ? "\ufeff" : "") + tail;
}

/** 原子写:同目录临时文件 + rename(Windows 上覆盖已有文件也是原子的) */
function atomicWrite(target: string, text: string): { hash: string; bytes: number } {
	mkdirSync(path.dirname(target), { recursive: true });
	const buf = Buffer.from(text, "utf8");
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, buf);
	try {
		renameSync(tmp, target);
	} catch (error) {
		try { unlinkSync(tmp); } catch { /* 忽略 */ }
		throw error;
	}
	return { hash: sha256(buf), bytes: buf.length };
}

/** 路径策略:allowOutsideRepo=false 时只允许仓库内路径 */
function resolveTarget(raw: string): { target?: string; error?: string } {
	const target = path.resolve(raw);
	if (config.fileWriteAllowOutsideRepo) return { target };
	const root = repoRoot();
	if (target === root || target.startsWith(root + path.sep)) return { target };
	return { error: `路径超出仓库范围(tools.fileWrite.allowOutsideRepo=false):${target}` };
}

/** 校验模型给的哈希:允许完整 sha256,也允许 >=8 位前缀(大小写不敏感) */
function hashMatches(current: string, expected: string): boolean {
	const value = expected.toLowerCase().replace(/^sha256:/, "").trim();
	return value.length >= MIN_HASH_INPUT && current.toLowerCase().startsWith(value);
}

function linesOf(content: string): string[] {
	const body = content.replace(/\r?\n$/, "");
	return body.length === 0 ? [] : body.split(/\r?\n/);
}

export async function execute(_ctx: ToolContext, params: any) {
	const filePath = String(params?.filePath ?? "").trim();
	const op = String(params?.op ?? "").trim();
	if (!filePath) return fail("需要 filePath(任意本地路径,或仓库内路径)。");
	if (!["create", "replace", "patch"].includes(op)) return fail("op 必填,取值只能是 create / replace / patch。");
	const resolved = resolveTarget(filePath);
	if (!resolved.target) return fail(resolved.error ?? "路径不合法");
	const target = resolved.target;

	if (op === "create") {
		if (existsSync(target)) {
			const existing = loadText(target);
			return fail(`文件已存在,不能新建:${target}\n如需覆盖,请先读取文件拿到 hash(${existing.id}),再用 op=replace + expectedHash 修改。`, { path: target, hash: existing.id });
		}
		const content = String(params?.content ?? "");
		if (content === "") return fail("create 需要 content(要写空文件请显式传 content: \"\" 并用 op=replace 覆盖已有文件)。");
		if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return fail(`内容超过 ${MAX_CONTENT_BYTES / 1024 / 1024}MB 限制。`);
		if (content.includes("\u0000")) return fail("内容含 NUL 字节,拒绝写入(本工具只处理文本)。");
		try {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") return fail(`文件已存在,拒绝新建:${target}(改用 op=replace + expectedHash)。`);
			return fail(`写入失败:${error instanceof Error ? error.message : String(error)}`);
		}
		const written = loadText(target);
		return ok(`已新建:${target}\n共 ${written.lines.length} 行,hash=${written.id}(后续修改请带上这个 hash)`, { path: target, op, hash: written.id, fullHash: written.hash, lines: written.lines.length });
	}

	if (!existsSync(target)) return fail(`文件不存在:${target}(新建请用 op=create)`);
	const expectedHash = String(params?.expectedHash ?? "").trim();
	if (!expectedHash) return fail("编辑现有文件必须带 expectedHash(读取文件时返回的 hash),用于确认你改的是同一版本。");
	let current: TextFile;
	try {
		current = loadText(target);
	} catch (error) {
		if (error instanceof Error && error.message === "BINARY") return fail(`看起来是二进制文件,本工具只处理文本:${target}`);
		return fail(`读取失败:${error instanceof Error ? error.message : String(error)}`);
	}
	if (!hashMatches(current.hash, expectedHash)) {
		return fail(
			`文件内容已变更,拒绝写入(CAS 未通过)。\n你给的 hash:${expectedHash}\n当前 hash:${current.id}\n当前共 ${current.lines.length} 行。\n请重新读取该文件,基于最新内容再改。`,
			{ path: target, hash: current.id, conflict: true },
		);
	}

	if (op === "replace") {
		const content = params?.content;
		if (typeof content !== "string") return fail("replace 需要 content(整份新内容)。");
		if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return fail(`内容超过 ${MAX_CONTENT_BYTES / 1024 / 1024}MB 限制。`);
		if (content.includes("\u0000")) return fail("内容含 NUL 字节,拒绝写入。");
		const written = atomicWrite(target, content);
		const next = loadText(target);
		return ok(`已整文件替换:${target}\n行数 ${current.lines.length} → ${next.lines.length},hash=${next.id}(旧 ${current.id})`, {
			path: target,
			op,
			hash: next.id,
			fullHash: written.hash,
			lines: next.lines.length,
			bytes: written.bytes,
			previousHash: current.id,
		});
	}

	const rawEdits = params?.edits;
	if (!Array.isArray(rawEdits) || rawEdits.length === 0) return fail("patch 需要 edits 数组,每项形如 { startLine, endLine?, content, expect? }。");
	const total = current.lines.length;
	if (total === 0) return fail("文件是空的,patch 没有可改的行;请用 op=replace 写整份内容。");
	const edits: Array<{ startLine: number; endLine: number; content: string }> = [];
	for (let i = 0; i < rawEdits.length; i++) {
		const raw = rawEdits[i] as EditInput;
		const startLine = Number(raw?.startLine);
		const endLine = raw?.endLine === undefined ? startLine : Number(raw.endLine);
		if (!Number.isInteger(startLine) || startLine < 1) return fail(`edits[${i}].startLine 必须是 >=1 的整数(行号从 1 开始)。`);
		if (!Number.isInteger(endLine) || endLine < startLine) return fail(`edits[${i}].endLine 必须 >= startLine。`);
		if (endLine > total) return fail(`edits[${i}] 行号越界:endLine=${endLine},文件只有 ${total} 行。`);
		const content = typeof raw?.content === "string" ? raw.content : "";
		const expect = typeof raw?.expect === "string" ? raw.expect : undefined;
		if (expect !== undefined && expect.trim() !== "") {
			const actual = current.lines.slice(startLine - 1, endLine).join(current.eol);
			if (actual.trim() !== expect.trim()) {
				return fail(`edits[${i}] 原文校验失败:第 ${startLine}-${endLine} 行实际是\n---\n${actual}\n---\n与 expect 不一致。请重新读取文件(确认行号)后再改。`, { path: target, hash: current.id, conflict: true });
			}
		}
		edits.push({ startLine, endLine, content });
	}
	const ascending = [...edits].sort((a, b) => a.startLine - b.startLine);
	for (let i = 1; i < ascending.length; i++) {
		if (ascending[i].startLine <= ascending[i - 1].endLine) {
			return fail(`edits 有重叠:第 ${ascending[i - 1].startLine}-${ascending[i - 1].endLine} 行 与 第 ${ascending[i].startLine}-${ascending[i].endLine} 行。请合并成一段。`);
		}
	}
	const nextLines = [...current.lines];
	const changes: Array<{ startLine: number; endLine: number; newLines: number }> = [];
	for (const edit of [...edits].sort((a, b) => b.startLine - a.startLine)) {
		const insert = linesOf(edit.content);
		nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...insert);
		changes.push({ startLine: edit.startLine, endLine: edit.endLine, newLines: insert.length });
	}
	const rendered = render(nextLines, current.eol, current.endsWithNewline, current.bom);
	const written = atomicWrite(target, rendered);
	const next = loadText(target);
	const changeText = changes
		.sort((a, b) => a.startLine - b.startLine)
		.map((c) => `第 ${c.startLine}${c.endLine > c.startLine ? `-${c.endLine}` : ""} 行 → ${c.newLines} 行`)
		.join("; ");
	return ok(`已局部修改:${target}\n${changeText}\n行数 ${current.lines.length} → ${next.lines.length},hash=${next.id}(旧 ${current.id})`, {
		path: target,
		op,
		hash: next.id,
		fullHash: written.hash,
		lines: next.lines.length,
		bytes: written.bytes,
		previousHash: current.id,
		changes,
	});
}