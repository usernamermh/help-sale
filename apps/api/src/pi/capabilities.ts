import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanExternalTools, TOOL_ROOTS } from "../services/external-tools.js";

export interface CapabilityDef {
	name: string;
	label: string;
	description: string;
	category: string;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * 能力清单由 tools / tools_system 目录动态生成:
 * 仅注册具备实现入口(默认 main.ts)且声明了函数(function_list / main.*)的工具,
 * 纯描述性目录(如 cluster/embedding)与未适配入口的工具不会出现。
 */
function buildCapabilities(): CapabilityDef[] {
	const out: CapabilityDef[] = [];
	for (const root of TOOL_ROOTS) {
		const rootPath = path.join(repoRoot, root);
		for (const t of scanExternalTools([rootPath])) {
			if (t.functions.length === 0) continue;
			const entry = t.entry ?? "main.ts";
			if (!existsSync(path.join(rootPath, t.dir, entry))) continue;
			out.push({
				name: t.name,
				label: t.label ?? t.name,
				description: t.description || t.name,
				category: t.category ?? "其他",
			});
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const CAPABILITIES: CapabilityDef[] = buildCapabilities();

export function capabilitiesFor(category?: string): CapabilityDef[] {
	return category ? CAPABILITIES.filter((c) => c.category === category) : CAPABILITIES;
}

export function getCapabilityDef(name: string): CapabilityDef | undefined {
	return CAPABILITIES.find((c) => c.name === name);
}

// 系统收口工具等不在目录里的展示名
const EXTRA_TOOL_LABELS: Record<string, string> = {
	emit_final: "输出最终结论",
	emit_analysis: "输出分析结论",
	emit_evaluation: "输出评估结论",
	emit_vehicle_plan: "输出优选方案",
	emit_digest: "输出通话/试驾总结",
};

export function toolLabel(name: string | undefined): string {
	if (!name) return "未知工具";
	const def = getCapabilityDef(name);
	if (def) return def.label;
	return EXTRA_TOOL_LABELS[name] ?? name;
}