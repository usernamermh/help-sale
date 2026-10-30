import { bool, num, str, strList } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { FeaturesConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `subagents`、`automation`、`workflows.mine`、`client` 四段:
 * 多代理并发与超时、定时任务时间点(晨报/周报/沉默唤醒)、工作流挖掘参数与前端挖掘超时。
 * 全部必填,代码里不提供任何默认值。
 */
export function loadFeaturesConfig(file: FileConfig): FeaturesConfig {
	return {
		subagentMaxConcurrency: num(file.subagents?.maxConcurrency, "subagents.maxConcurrency"),
		subagentPollIntervalMs: num(file.subagents?.pollIntervalMs, "subagents.pollIntervalMs"),
		subagentIdleSweepIntervalMs: num(file.subagents?.idleSweepIntervalMs, "subagents.idleSweepIntervalMs"),
		subagentTimeoutMs: num(file.subagents?.timeoutMs, "subagents.timeoutMs"),
		subagentDefaultTools: strList(file.subagents?.defaultTools, "subagents.defaultTools"),
		automationEnabled: bool(file.automation?.enabled, "automation.enabled"),
		morningDigestTime: str(file.automation?.morningDigestTime, "automation.morningDigestTime"),
		weeklyReportWeekday: num(file.automation?.weeklyReportWeekday, "automation.weeklyReportWeekday"),
		weeklyReportTime: str(file.automation?.weeklyReportTime, "automation.weeklyReportTime"),
		silentCustomerDays: num(file.automation?.silentCustomerDays, "automation.silentCustomerDays"),
		silentWakeupEnabled: bool(file.automation?.silentWakeupEnabled, "automation.silentWakeupEnabled"),
		wakeupTaskTime: str(file.automation?.wakeupTaskTime, "automation.wakeupTaskTime"),
		workflowMineDays: num(file.workflows?.mine?.days, "workflows.mine.days"),
		workflowMineMinWindow: num(file.workflows?.mine?.minWindow, "workflows.mine.minWindow"),
		workflowMineMaxWindow: num(file.workflows?.mine?.maxWindow, "workflows.mine.maxWindow"),
		workflowMineMinCount: num(file.workflows?.mine?.minCount, "workflows.mine.minCount"),
		workflowMineTopChains: num(file.workflows?.mine?.topChains, "workflows.mine.topChains"),
		workflowMineRefineTop: num(file.workflows?.mine?.refineTop, "workflows.mine.refineTop"),
		workflowMineTimeoutMs: num(file.client?.workflowMineTimeoutMs, "client.workflowMineTimeoutMs"),
		workflowMineDedupe: bool(file.workflows?.mine?.dedupe, "workflows.mine.dedupe"),
	};
}
