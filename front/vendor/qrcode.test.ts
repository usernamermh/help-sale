import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * 二维码编码器的回归基线:期望值由参考实现(Python qrcode,ISO/IEC 18004)逐模块比对确认后固化。
 * 改动 vendor/qrcode.js 后这里会红,必须先确认新输出仍能被扫码器识别。
 */
interface QrLite {
	matrix(text: string, options?: { ecc?: string; mask?: number; version?: number }): boolean[][];
}
const globalScope = globalThis as unknown as { QRLite?: QrLite };
// @ts-expect-error 纯前端资源没有类型声明,这里只需要它执行后把 QRLite 挂到 globalThis
await import("./qrcode.js");

function matrixOf(text: string, ecc: string): boolean[][] {
	const qr = globalScope.QRLite;
	if (!qr) throw new Error("qrcode.js 没有挂载 QRLite");
	return qr.matrix(text, { ecc });
}

function digest(modules: boolean[][]): { size: number; sha256: string } {
	return {
		size: modules.length,
		sha256: createHash("sha256")
			.update(modules.map((row) => row.map((v) => (v ? "1" : "0")).join("")).join("\n"))
			.digest("hex"),
	};
}

const LOGIN_URL = "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=081734daea8d546a68a7117de2722fb3&bot_type=3";

describe("二维码编码器", () => {
	it("微信登录链接输出与基线一致", () => {
		expect(digest(matrixOf(LOGIN_URL, "M"))).toEqual({
			size: 41,
			sha256: "9eed5724cf1938172fd23a18b76fa586d581b66fb34ffbeaf8d5625b633f7d49",
		});
	});

	it("中文内容与更高纠错等级同样稳定", () => {
		expect(digest(matrixOf("微信登录二维码渲染测试", "M"))).toEqual({
			size: 29,
			sha256: "de76934068c6f9bb64058624a9086a07e1cf732363037e1dfb1f33f2448a087c",
		});
		expect(digest(matrixOf(LOGIN_URL.replace("7GiQu1", "AbCdEf"), "Q"))).toEqual({
			size: 49,
			sha256: "8acc9e2ccd8614816d0995a5bd76df35af4445d7e0e2c5c6b9499dd84afbd066",
		});
	});

	it("矩阵结构合规:尺寸为 4n+17,三个定位图形与行列时间线齐全", () => {
		const modules = matrixOf(LOGIN_URL, "M");
		const size = modules.length;
		expect((size - 17) % 4).toBe(0);
		const core = [
			"1111111",
			"1000001",
			"1011101",
			"1011101",
			"1011101",
			"1000001",
			"1111111",
		];
		for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
			for (let dy = -3; dy <= 3; dy++) {
				for (let dx = -3; dx <= 3; dx++) {
					expect(modules[cy + dy][cx + dx]).toBe(core[dy + 3][dx + 3] === "1");
				}
			}
			expect(modules[cy - 4]?.[cx] ?? false).toBe(false);
			expect(modules[cy][cx - 4] ?? false).toBe(false);
		}
		for (let i = 8; i < size - 8; i++) expect(modules[6][i]).toBe(i % 2 === 0);
		expect(modules[size - 8][8]).toBe(true);
	});

	it("同一内容换掩码会得到不同图形,但尺寸不变", () => {
		const auto = matrixOf(LOGIN_URL, "M");
		const qr = globalScope.QRLite!;
		const forced = qr.matrix(LOGIN_URL, { ecc: "M", mask: 0 });
		expect(forced.length).toBe(auto.length);
		expect(JSON.stringify(forced)).not.toBe(JSON.stringify(auto));
	});
});