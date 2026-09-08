import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import zlib from "node:zlib";
import { loadExternalAgentTools } from "./external-tools.js";
import { repoRoot } from "../../../../tools_system/_shared/file-utils.js";

const ROOTS = [path.join(repoRoot(), "tools"), path.join(repoRoot(), "tools_system")];
const tmpFiles: string[] = [];

function tmpPath(ext: string): string {
	const f = path.join(os.tmpdir(), `fr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
	tmpFiles.push(f);
	return f;
}

afterEach(() => {
	for (const f of tmpFiles.splice(0)) {
		try { fs.rmSync(f, { force: true }); } catch {}
	}
});

async function fileRead(params: Record<string, unknown>) {
	const tools = await loadExternalAgentTools(ROOTS, { db: null, tenantId: "t1" } as never);
	const tool = tools.find((t) => t.name === "file_read")!;
	const r = (await tool.execute("f1", params)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
	return { text: r.content.map((c) => c.text).join(""), details: r.details };
}

describe("file_read 任意路径读取", () => {
	it("txt:仓库外任意路径可读", async () => {
		const f = tmpPath(".txt");
		fs.writeFileSync(f, "任意路径的文本内容:销售军师", "utf8");
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("销售军师");
	});

	it("xlsx:仓库外任意路径可读", async () => {
		const XLSX = (await import("xlsx")) as typeof import("xlsx");
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["车型", "价格"], ["汉EV", "25万"]]), "车型表");
		const f = tmpPath(".xlsx");
		fs.writeFileSync(f, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("汉EV");
	});

	it("pptx:仓库外任意路径可读", async () => {
		const zip = new AdmZip();
		zip.addFile("ppt/presentation.xml", Buffer.from("<p:presentation/>"));
		zip.addFile("ppt/slides/slide1.xml", Buffer.from('<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>任意路径PPT内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'));
		const f = tmpPath(".pptx");
		zip.writeZip(f);
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("任意路径PPT内容");
	});

	it("docx:仓库外任意路径可读", async () => {
		const zip = new AdmZip();
		zip.addFile("[Content_Types].xml", Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));
		zip.addFile("word/document.xml", Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>任意路径Word内容</w:t></w:r></w:p></w:body></w:document>'));
		const f = tmpPath(".docx");
		zip.writeZip(f);
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("任意路径Word内容");
	});

	it("pdf:仓库外任意路径可读(未压缩流)", async () => {
		const f = tmpPath(".pdf");
		fs.writeFileSync(f, minimalPdf("Hello PDF 任意路径"));
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("Hello PDF 任意路径");
	});

	it("pdf:支持 FlateDecode 压缩内容流", async () => {
		const f = tmpPath(".pdf");
		fs.writeFileSync(f, compressedPdf("压缩流 PDF 文本"));
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("压缩流 PDF 文本");
	});
	it("不存在的文件返回错误", async () => {
		const f = path.join(os.tmpdir(), `fr-missing-${Date.now()}.txt`);
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("不存在");
	});

	it("不支持的文件类型拒绝", async () => {
		const f = tmpPath(".exe");
		fs.writeFileSync(f, "MZ", "utf8");
		const { text } = await fileRead({ filePath: f });
		expect(text).toContain("不支持");
	});
});

/** 生成一个最小编号 PDF:单页,未压缩内容流,含一段 Tj 文本。 */
function minimalPdf(text: string): Buffer {
	const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
	const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		`4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`,
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	];
	const body = objects.join("");
	const xrefOffset = Buffer.byteLength("%PDF-1.4\n") + Buffer.byteLength(body);
	const xref = `xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000218 00000 n \n0000000313 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.concat([Buffer.from("%PDF-1.4\n", "utf8"), Buffer.from(body, "utf8"), Buffer.from(xref, "utf8")]);
}

/** 生成压缩内容流的最小 PDF:stream 内容经 FlateDecode 压缩,压缩字节按二进制原样写入。 */
function compressedPdf(text: string): Buffer {
	const raw = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
	const content = zlib.deflateSync(Buffer.from(raw, "utf8"));
	const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "utf8");
	const tail = Buffer.from("\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n", "utf8");
	const xrefOffset = Buffer.byteLength("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length " + content.length + " /Filter /FlateDecode >>\nstream\n") + content.length + Buffer.byteLength(tail);
	const xref = `xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000218 00000 n \n0000000313 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.concat([head, content, tail, Buffer.from(xref, "utf8")]);
}
