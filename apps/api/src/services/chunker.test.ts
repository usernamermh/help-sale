import { describe, expect, it } from "vitest";
import { splitText } from "./chunker.js";

describe("splitText", () => {
	it("空文本返回空数组", () => {
		expect(splitText("", { size: 100 })).toEqual([]);
	});

	it("短文本单块", () => {
		expect(splitText("你好", { size: 100 })).toEqual(["你好"]);
	});

	it("超长文本切成多块且每块不超限", () => {
		const text = "字".repeat(500) + "\n\n" + "词".repeat(500);
		const chunks = splitText(text, { size: 300, overlap: 50 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
		expect(chunks.join("").length).toBeLessThan(1000); // 去重后总长缩小
	});

	it("段落合并不超过上限", () => {
		const paragraphs = ["一".repeat(200), "二".repeat(200), "三".repeat(200)];
		const chunks = splitText(paragraphs.join("\n\n"), { size: 450, overlap: 0 });
		expect(chunks.length).toBe(2);
		expect(chunks[0].length).toBeLessThanOrEqual(450);
	});
});