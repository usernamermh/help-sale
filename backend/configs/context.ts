import { bool, num } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { ContextConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `context.compression` 段:长对话记忆的增量压缩参数。
 * 全部必填,代码里不提供任何默认值。
 */
export function loadContextConfig(file: FileConfig): ContextConfig {
	return {
		compressionEnabled: bool(file.context?.compression?.enabled, "context.compression.enabled"),
		compressionThresholdRatio: num(file.context?.compression?.thresholdRatio, "context.compression.thresholdRatio"),
		compressionKeepHead: num(file.context?.compression?.keepHead, "context.compression.keepHead"),
		compressionKeepTail: num(file.context?.compression?.keepTail, "context.compression.keepTail"),
		compressionMinMessages: num(file.context?.compression?.minMessages, "context.compression.minMessages"),
		compressionMaxSummaryChars: num(file.context?.compression?.maxSummaryChars, "context.compression.maxSummaryChars"),
	};
}
