import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute as fileWrite } from "../../tools_system/file_write/main.js";
import { execute as txtRead } from "../../tools_system/txt/main.js";

/**
 * file_write:create / replace / patch 的 CAS 行为。
 * 覆盖点:新建冲突、哈希不符、行号越界、原文(expect)不符、区间重叠、删行、CRLF/BOM 保留。
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "file-write-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
const target = (name = "note.md") => path.join(dir, name);
const ctx = { db: null, tenantId: "t1" };

describe("file_write:新建", () => {
	it("新建成功并返回 hash;重复新建被拒绝并给出当前 hash", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "第一行\n第二行\n" });
		expect(text(created)).toContain("已新建");
		const hash = (created.details as { hash: string }).hash;
		expect(hash).toHaveLength(12);
		expect(readFileSync(file, "utf8")).toBe("第一行\n第二行\n");

		const again = await fileWrite(ctx, { filePath: file, op: "create", content: "覆盖" });
		expect(text(again)).toContain("文件已存在");
		expect(text(again)).toContain(hash);
		expect(readFileSync(file, "utf8")).toBe("第一行\n第二行\n");
	});

	it("op 缺失或非法直接拒绝", async () => {
		expect(text(await fileWrite(ctx, { filePath: target(), content: "x" }))).toContain("op 必填");
		expect(text(await fileWrite(ctx, { filePath: target(), op: "append", content: "x" }))).toContain("op 必填");
	});
});

describe("file_write:整文件替换(replace)", () => {
	it("带正确 hash 可以替换,并返回新 hash", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "a\nb\n" });
		const oldHash = (created.details as { hash: string }).hash;
		const replaced = await fileWrite(ctx, { filePath: file, op: "replace", expectedHash: oldHash, content: "x\ny\nz\n" });
		expect(text(replaced)).toContain("已整文件替换");
		const newHash = (replaced.details as { hash: string }).hash;
		expect(newHash).not.toBe(oldHash);
		expect(readFileSync(file, "utf8")).toBe("x\ny\nz\n");
	});

	it("hash 对不上(文件被人改过)时拒绝,并回当前 hash", async () => {
		const file = target();
		await fileWrite(ctx, { filePath: file, op: "create", content: "原始\n" });
		writeFileSync(file, "被别的进程改了\n", "utf8");
		const stale = "000000000000";
		const result = await fileWrite(ctx, { filePath: file, op: "replace", expectedHash: stale, content: "不该写进去\n" });
		expect(text(result)).toContain("CAS 未通过");
		expect(text(result)).toContain("请重新读取");
		expect(readFileSync(file, "utf8")).toBe("被别的进程改了\n");
	});

	it("不带 expectedHash 一律拒绝", async () => {
		const file = target();
		await fileWrite(ctx, { filePath: file, op: "create", content: "a\n" });
		expect(text(await fileWrite(ctx, { filePath: file, op: "replace", content: "b\n" }))).toContain("必须带 expectedHash");
	});
});

describe("file_write:按行号局部修改(patch)", () => {
	it("替换指定行,行号从 1 开始,返回新 hash", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "第一行\n第二行\n第三行\n" });
		const hash = (created.details as { hash: string }).hash;
		const patched = await fileWrite(ctx, {
			filePath: file,
			op: "patch",
			expectedHash: hash,
			edits: [{ startLine: 2, content: "改过的第二行", expect: "第二行" }],
		});
		expect(text(patched)).toContain("已局部修改");
		expect(text(patched)).toContain("第 2 行 → 1 行");
		expect(readFileSync(file, "utf8")).toBe("第一行\n改过的第二行\n第三行\n");
	});

	it("expect 与实际内容不符时拒绝(防止行号算错)", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "AA\nBB\n" });
		const hash = (created.details as { hash: string }).hash;
		const result = await fileWrite(ctx, {
			filePath: file,
			op: "patch",
			expectedHash: hash,
			edits: [{ startLine: 2, content: "CC", expect: "不对的原文" }],
		});
		expect(text(result)).toContain("原文校验失败");
		expect(text(result)).toContain("BB");
		expect(readFileSync(file, "utf8")).toBe("AA\nBB\n");
	});

	it("行号越界 / 区间重叠 / 空文件都拒绝", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "1\n2\n3\n" });
		const hash = (created.details as { hash: string }).hash;
		expect(text(await fileWrite(ctx, { filePath: file, op: "patch", expectedHash: hash, edits: [{ startLine: 9, content: "x" }] }))).toContain("越界");
		expect(
			text(await fileWrite(ctx, { filePath: file, op: "patch", expectedHash: hash, edits: [{ startLine: 1, endLine: 2, content: "x" }, { startLine: 2, content: "y" }] })),
		).toContain("重叠");

		const empty = target("empty.txt");
		writeFileSync(empty, "", "utf8");
		const emptyHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
		expect(text(await fileWrite(ctx, { filePath: empty, op: "patch", expectedHash: emptyHash, edits: [{ startLine: 1, content: "y" }] }))).toContain("文件是空的");
	});

	it("content 为空串 = 删除该区间", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "keep1\ndrop\nkeep2\n" });
		const hash = (created.details as { hash: string }).hash;
		const patched = await fileWrite(ctx, { filePath: file, op: "patch", expectedHash: hash, edits: [{ startLine: 2, content: "" }] });
		expect(text(patched)).toContain("→ 0 行");
		expect(readFileSync(file, "utf8")).toBe("keep1\nkeep2\n");
	});

	it("多次编辑一次提交,按行号降序应用不会互相影响", async () => {
		const file = target();
		const created = await fileWrite(ctx, { filePath: file, op: "create", content: "1\n2\n3\n4\n5\n" });
		const hash = (created.details as { hash: string }).hash;
		await fileWrite(ctx, {
			filePath: file,
			op: "patch",
			expectedHash: hash,
			edits: [{ startLine: 5, content: "five" }, { startLine: 1, content: "one\nextra" }],
		});
		expect(readFileSync(file, "utf8")).toBe("one\nextra\n2\n3\n4\nfive\n");
	});
});

describe("读取 → 编辑 联动", () => {
	it("txt 返回行号与 hash;用它 patch 后 CRLF 与 BOM 原样保留", async () => {
		const tmpDir = path.join("E:/proj_help_sale_v2/.tmp");
		mkdirSync(tmpDir, { recursive: true });
		const repoFile = path.join(tmpDir, "eol-check.txt");
		writeFileSync(repoFile, "\ufeff第一行\r\n第二行\r\n第三行\r\n", "utf8");
		try {
			const read = await txtRead(ctx, { filePath: ".tmp/eol-check.txt" });
			const shown = text(read);
			expect(shown).toContain("共 3 行");
			expect(shown).toContain("换行=CRLF");
			expect(shown).toContain("含 BOM");
			expect(shown).toContain("2| 第二行");
			const hash = (read.details as { hash: string }).hash;
			expect(hash).toHaveLength(12);

			const patched = await fileWrite(ctx, { filePath: repoFile, op: "patch", expectedHash: hash, edits: [{ startLine: 2, content: "改过", expect: "第二行" }] });
			expect(text(patched)).toContain("已局部修改");
			expect(readFileSync(repoFile, "utf8")).toBe("\ufeff第一行\r\n改过\r\n第三行\r\n");
		} finally {
			rmSync(repoFile, { force: true });
		}
	});
});