import { num, str } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { DefaultsConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `defaults`、`company` 与顶层 `userkey`:
 * 各业务接口的默认天数/条数(模型与前端不再各自硬编码)、公司团队展示名、调用方标识。
 * 全部必填,代码里不提供任何默认值。
 */
export function loadDefaultsConfig(file: FileConfig): DefaultsConfig {
	return {
		companyName: str(file.company?.name, "company.name"),
		teamName: str(file.company?.team, "company.team"),
		userKey: str(file.userkey, "userkey"),
		insightsDays: num(file.defaults?.insightsDays, "defaults.insightsDays"),
		improvementsDays: num(file.defaults?.improvementsDays, "defaults.improvementsDays"),
		conversationsLimit: num(file.defaults?.conversationsLimit, "defaults.conversationsLimit"),
		dealsLimit: num(file.defaults?.dealsLimit, "defaults.dealsLimit"),
		storeOverviewDays: num(file.defaults?.storeOverviewDays, "defaults.storeOverviewDays"),
		customersLimit: num(file.defaults?.customersLimit, "defaults.customersLimit"),
		knowledgeCandidatesLimit: num(file.defaults?.knowledgeCandidatesLimit, "defaults.knowledgeCandidatesLimit"),
		agentThreadsLimit: num(file.defaults?.agentThreadsLimit, "defaults.agentThreadsLimit"),
		transcriptLimit: num(file.defaults?.transcriptLimit, "defaults.transcriptLimit"),
		agentListLimit: num(file.defaults?.agentListLimit, "defaults.agentListLimit"),
		notificationScanLimit: num(file.defaults?.notificationScanLimit, "defaults.notificationScanLimit"),
		remindersTakeLimit: num(file.defaults?.remindersTakeLimit, "defaults.remindersTakeLimit"),
	};
}
