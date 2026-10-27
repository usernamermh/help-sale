import { describe, expect, it } from "vitest";
import { parseBilingualQuery } from "./query-rewrite.js";

/**
 * 只验解析层(不联网、不调模型):宿主拿到模型输出后必须能稳定取出 {zh,en},
 * 取不到就退回用户原话,不允许把这一层的异常抛到 agent 主流程里。
 */
describe("双语 query 改写的解析", () => {
	it("解析 ```json 代码块", () => {
		const raw = '```json\n{"zh":"客户跟进复盘 workflow","en":"customer follow-up review workflow"}\n```';
		expect(parseBilingualQuery(raw)).toEqual({ zh: "客户跟进复盘 workflow", en: "customer follow-up review workflow" });
	});

	it("容忍前后废话与裸 JSON", () => {
		const raw = '好的,这是改写结果:{"zh":"列出 PR","en":"list pull requests"} 希望有帮助';
		expect(parseBilingualQuery(raw)).toEqual({ zh: "列出 PR", en: "list pull requests" });
	});

	it("缺字段时按缺的那个返回,全缺或非法 JSON 返回 undefined", () => {
		expect(parseBilingualQuery('{"zh":"只有中文"}')).toEqual({ zh: "只有中文", en: "" });
		expect(parseBilingualQuery('{"foo":1}')).toBeUndefined();
		expect(parseBilingualQuery("不是 JSON")).toBeUndefined();
		expect(parseBilingualQuery("")).toBeUndefined();
	});
});