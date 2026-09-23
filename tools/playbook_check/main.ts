import { cleanText } from "../../tools_system/_shared/text-vec.js";
import { embedTextsSafe } from "../../tools_system/_shared/bge-embed.js";

interface ToolContext { db: any; tenantId: string; }

interface Phrase { id: string; docId: string; docTitle: string; content: string; }
interface HitRow { conversationId: string; customerKey: string | null; customerName: string | null; salesName: string | null; date: string | null; sentence: string; phraseId: string; phrase: string; matchType: "exact" | "semantic"; score: number; }

/**
 * 话术命中质检:把某销售最近 N 条对话(录音转写)的销售发言,对照话术库(标准话术)做命中检测。
 * 双通道:①原文命中(归一化后句子包含话术原文);②语义命中(字符 n-gram 向量余弦相似度≥阈值)。
 * 输出:命中明细 + 话术覆盖统计 + 可展示的 Markdown 表格。
 */
export async function execute(ctx: ToolContext, params: any) {
	const db = ctx.db;
	const tenantId = ctx.tenantId;
	const days = Math.max(1, Math.min(Number(params?.days ?? 30) || 30, 365));
	const limit = Math.max(1, Math.min(Number(params?.limit ?? 20) || 20, 100));
	const threshold = Number(params?.threshold ?? 0.72);
	const category = params?.category ? String(params.category).trim() : ""; // 空=匹配全部类别,显式传分类才过滤
	const salesName = params?.salesName ? String(params.salesName).trim() : "";
	const salesId = params?.salesId ? String(params.salesId).trim() : "";

	// 1) 话术库:knowledge_documents(category 含关键词)+ chunks
	const phraseRows = (
		category
			? db
					.prepare(
						`SELECT kc.id, kc.document_id, kc.content, kd.title
						 FROM knowledge_chunks kc
						 JOIN knowledge_documents kd ON kd.id = kc.document_id
						 WHERE kc.tenant_id = ? AND kd.category LIKE ?
						 ORDER BY kd.created_at, kc.chunk_index`,
					)
					.all(tenantId, `%${category}%`)
			: db
					.prepare(
						`SELECT kc.id, kc.document_id, kc.content, kd.title
						 FROM knowledge_chunks kc
						 JOIN knowledge_documents kd ON kd.id = kc.document_id
						 WHERE kc.tenant_id = ?
						 ORDER BY kd.created_at, kc.chunk_index`,
					)
					.all(tenantId)
	) as Array<{ id: string; document_id: string; content: string; title: string }>;
	const phrases: Phrase[] = phraseRows
		.map((r) => ({ id: String(r.id), docId: String(r.document_id), docTitle: String(r.title), content: String(r.content ?? "").trim() }))
		.filter((p) => p.content.length > 0);
	if (phrases.length === 0) {
		return { content: [{ type: "text", text: category ? `话术库暂无数据(category 含「${category}」的知识点为空),请先用 knowledge_ingest 沉淀标准话术。` : "话术库暂无数据(知识库没有可用知识点),请先用 knowledge_ingest 沉淀标准话术。" }], details: { phrases: 0, conversations: 0, hits: [], stats: null } };
	}

	// 2) 会话:按销售(姓名或 ID)与时间范围取最近 N 条
	const since = new Date(Date.now() - days * 86400000).toISOString();
	const convoRows = db
		.prepare(
			`SELECT c.id, c.sales_name, c.sales_id, c.updated_at, c.message_count,
			        cus.key AS customer_key, cus.name AS customer_name
			 FROM conversations c
			 LEFT JOIN customers cus ON cus.id = c.customer_id
			 WHERE c.tenant_id = ? AND c.updated_at >= ?
			   AND (? = '' OR c.sales_name = ? OR c.sales_id = ?)
			 ORDER BY c.updated_at DESC LIMIT ?`,
		)
		.all(tenantId, since, salesName, salesName, salesId, limit) as Array<{ id: string; sales_name: string | null; sales_id: string | null; updated_at: string | null; message_count: number | null; customer_key: string | null; customer_name: string | null }>;
	if (convoRows.length === 0) {
		return { content: [{ type: "text", text: "未找到符合条件的对话记录(请检查销售姓名/ID 或时间范围)。" }], details: { phrases: phrases.length, conversations: 0, hits: [], stats: null } };
	}

	// 3) 只取销售角色的发言句子
	const conversations = convoRows.map((c) => {
		const msgs = db
			.prepare(
				"SELECT content, spoken_at FROM conversation_messages WHERE tenant_id = ? AND conversation_id = ? AND speaker_role = 'sales' ORDER BY seq",
			)
			.all(tenantId, c.id) as Array<{ content: string | null; spoken_at: string | null }>;
		return {
			id: String(c.id),
			customerKey: c.customer_key ? String(c.customer_key) : null,
			customerName: c.customer_name ? String(c.customer_name) : null,
			salesName: c.sales_name ? String(c.sales_name) : null,
			date: c.updated_at ? String(c.updated_at) : null,
			sentences: msgs.map((m) => String(m.content ?? "").trim()).filter((s) => s.length > 0),
		};
	});

	// 4) 双通道匹配
	const phraseCleans = phrases.map((p) => cleanText(p.content));
	// 话术向量批量一次(L2 归一化,余弦=点积);Float32Array 加速同步点积
	const phraseF32 = (await embedTextsSafe(phrases.map((ph) => ph.content))).map((v) => Float32Array.from(v));
	const dotF32 = (a: Float32Array, b: Float32Array): number => {
		let d = 0;
		for (let i = 0; i < a.length; i++) d += a[i] * b[i];
		return d;
	};
	const hits: HitRow[] = [];
	const pushHit = (conv: (typeof conversations)[number], sentence: string, matched: { pi: number; type: "exact" | "semantic"; score: number }) => {
		const p = phrases[matched.pi];
		hits.push({
			conversationId: conv.id,
			customerKey: conv.customerKey,
			customerName: conv.customerName,
			salesName: conv.salesName,
			date: conv.date,
			sentence,
			phraseId: p.id,
			phrase: p.content,
			matchType: matched.type,
			score: matched.score,
		});
	};

	// 通道 A:原文命中(句级,纯字符串比较,不消耗 embedding)
	const exactHitSet = new Set<string>(); // convIdx:sentIdx
	for (let ci = 0; ci < conversations.length; ci++) {
		const conv = conversations[ci];
		for (let si = 0; si < conv.sentences.length; si++) {
			const clean = cleanText(conv.sentences[si]);
			if (!clean) continue;
			for (let i = 0; i < phrases.length; i++) {
				if (phraseCleans[i].length >= 4 && clean.includes(phraseCleans[i])) {
					pushHit(conv, conv.sentences[si], { pi: i, type: "exact", score: 1 });
					exactHitSet.add(`${ci}:${si}`);
					break;
				}
			}
		}
	}

	// 通道 B:语义命中(同一会话内每 20 句一组,每组一次 embedding,组向量 vs 话术向量;同步点积分批让出事件循环)
	const GROUP_SIZE = 20;
	const groups: Array<{ convIdx: number; sentences: string[] }> = [];
	for (let ci = 0; ci < conversations.length; ci++) {
		const conv = conversations[ci];
		const unmat = conv.sentences
			.map((sentence, si) => ({ sentence, si }))
			.filter(({ si }) => !exactHitSet.has(`${ci}:${si}`))
			.map(({ sentence }) => sentence)
			.filter((sentence) => cleanText(sentence).length > 0);
		for (let k = 0; k < unmat.length; k += GROUP_SIZE) {
			groups.push({ convIdx: ci, sentences: unmat.slice(k, k + GROUP_SIZE) });
		}
	}
	const groupVecs = groups.length > 0 ? await embedTextsSafe(groups.map((g) => g.sentences.join(" "))) : [];
	const groupF32 = groupVecs.map((v) => Float32Array.from(v));
	for (let k = 0; k < groups.length; k++) {
		const g = groups[k];
		const conv = conversations[g.convIdx];
		let best = -1;
		let bestScore = 0;
		for (let i = 0; i < phraseF32.length; i++) {
			const sc = dotF32(groupF32[k], phraseF32[i]);
			if (sc > bestScore) {
				bestScore = sc;
				best = i;
			}
		}
		if (best >= 0 && bestScore >= threshold) {
			const snippet = g.sentences.join(" / ").slice(0, 120);
			pushHit(conv, snippet, { pi: best, type: "semantic", score: Number(bestScore.toFixed(4)) });
		}
		// 每 10 组让出事件循环一次,避免同步点积长时间占住主线程(页面/看板请求不被卡住)
		if (k % 10 === 9) await new Promise((r) => setImmediate(r));
	}
	// 5) 聚合统计
	const usedPhraseIds = new Set(hits.map((h) => h.phraseId));
	const stats = {
		conversations: conversations.length,
		sentences: conversations.reduce((s, c) => s + c.sentences.length, 0),
		phrases: phrases.length,
		hitSentences: hits.length,
		exactHits: hits.filter((h) => h.matchType === "exact").length,
		semanticHits: hits.filter((h) => h.matchType === "semantic").length,
		phrasesUsed: usedPhraseIds.size,
		coverageRate: Number(((usedPhraseIds.size / phrases.length) * 100).toFixed(1)),
	};
	const rows = hits
		.slice(0, 50)
		.map((h) => `| ${h.date ? String(h.date).slice(0, 10) : "—"} | ${h.customerName ?? h.customerKey ?? "—"} | ${h.salesName ?? "—"} | ${h.phrase.replace(/\|/g, "｜")} | ${h.matchType === "exact" ? "原文" : "语义"} | ${h.score} |`);
	const rawTable =
		rows.length === 0
			? ""
			: "| 会话日期 | 客户 | 销售 | 命中话术 | 命中方式 | 相似度 |\n| --- | --- | --- | --- | --- | --- |\n" + rows.join("\n") + (hits.length > 50 ? `\n(仅展示前 50 条,共 ${hits.length} 条命中)` : "");
	const summary =
		`完成话术命中质检:检查 ${stats.conversations} 条对话、${stats.sentences} 句销售发言,对照 ${stats.phrases} 条标准话术。命中 ${stats.hitSentences} 句(原文 ${stats.exactHits} / 语义 ${stats.semanticHits}),覆盖 ${stats.phrasesUsed} 条话术(覆盖率 ${stats.coverageRate}%)` +
		(stats.hitSentences === 0 ? ",未发现明显使用标准话术的发言。" : ",明细见下表。");

	return {
		content: [{ type: "text", text: summary }],
		details: { phrases: phrases.length, conversations: conversations.length, hits, stats, rawTable },
	};
}
