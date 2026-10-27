// 导入真实数据:智己汽车话术点(1130)+ 电话对话(883 段)
// 用法: node scripts/import-real-data.mjs
// 说明: 清空全部业务表(保留 t_demo 租户并改名「智己」),导入后可重复执行(按 source_id 幂等)。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.BUSINESS_DB || path.join(repoRoot, "apps", "api", "data", "business.db");
const PLAYBOOK_FILE = "C:/Users/YZS/Desktop/提取话术点.json";
const FORMAT_DIR = "C:/Users/YZS/Desktop/format";
const TENANT_ID = "t_demo";
const TENANT_NAME = "智己";
const SALES_ID = "s_zhiji";
const SALES_NAME = "主理人";

const ALL_TABLES = [
  "agent_capabilities", "agent_events", "agent_plans", "agent_thread_messages", "agent_threads",
  "analyses", "automation_jobs", "automation_runs", "builtin_job_settings", "conversation_messages",
  "conversations", "customer_tags", "customers", "deals", "digests", "knowledge_candidates",
  "knowledge_chunks", "knowledge_documents", "next_step_tasks", "notification_logs",
  "reflection_cases", "sales", "stores", "test_drives", "thread_summaries", "tool_call_cache",
  "vehicle_match_plans", "vehicles", "workflows",
];

const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "郑"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "军", "洋", "勇", "艳", "杰", "涛", "明", "超", "霞", "平", "刚", "婷", "雪", "晨"];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function fakeName(key) {
  const h = hashStr(key);
  return SURNAMES[h % SURNAMES.length] + GIVEN[(h >>> 3) % GIVEN.length];
}
function fakePhone(key) {
  const h = hashStr("p" + key);
  return "138" + String(10000000 + (h % 90000000)).slice(0, 8);
}

function ensureColumns(db) {
  const add = (table, col, ddl) => {
    const cols = db.prepare("PRAGMA table_info(" + table + ")").all().map((r) => r.name);
    if (!cols.includes(col)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + ddl + ";");
  };
  add("knowledge_documents", "source_id", "TEXT");
  add("knowledge_documents", "key_content", "TEXT");
  add("knowledge_documents", "kind_code", "TEXT");
  add("knowledge_documents", "necessity", "INTEGER");
  add("knowledge_documents", "score", "INTEGER");
  add("knowledge_documents", "status", "INTEGER");
  add("knowledge_documents", "tag_ids", "TEXT");
  add("knowledge_documents", "kind_path_json", "TEXT");
  add("knowledge_documents", "cust_id", "TEXT");
  add("conversations", "source_id", "TEXT");
  add("conversations", "audio_date", "TEXT");
  add("conversations", "complex_url", "TEXT");
  add("conversations", "info_json", "TEXT");
  add("conversations", "raw_json", "TEXT");
  add("conversation_messages", "start_ms", "INTEGER");
  add("conversation_messages", "end_ms", "INTEGER");
  add("conversation_messages", "speaker", "TEXT");
  add("conversation_messages", "file_start_time", "TEXT");
}

function clearAll(db) {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  try {
    for (const t of ALL_TABLES) db.exec("DELETE FROM " + t + ";");
    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function ensureTenantAndSales(db) {
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?,?,?)").run(TENANT_ID, TENANT_NAME, "zhiji");
  db.prepare("UPDATE tenants SET name = ? WHERE id = ?").run(TENANT_NAME, TENANT_ID);
  db.prepare("INSERT OR IGNORE INTO sales (id, tenant_id, name, role) VALUES (?,?,?,?)").run(SALES_ID, TENANT_ID, SALES_NAME, "sales");
}

function importPlaybook(db) {
  const p = JSON.parse(fs.readFileSync(PLAYBOOK_FILE, "utf8"));
  const list = Array.isArray(p) ? p : p.knowledgeList || p.data?.knowledgeList || [];
  let inserted = 0, skipped = 0;
  const hasDoc = db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND source_id = ?");
  const insDoc = db.prepare(
    "INSERT INTO knowledge_documents (id, tenant_id, title, source_type, content, category, source_id, key_content, kind_code, necessity, score, status, tag_ids, kind_path_json, cust_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insChunk = db.prepare("INSERT INTO knowledge_chunks (id, tenant_id, document_id, chunk_index, content) VALUES (?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    for (const k of list) {
      const sid = String(k.id ?? "");
      if (!sid || hasDoc.get(TENANT_ID, sid)) { skipped++; continue; }
      const docId = "kdoc_" + sid;
      const chunkId = "kchunk_" + sid;
      const content = String(k.knowledgeContent ?? k.content ?? "").trim();
      if (!content) { skipped++; continue; }
      insDoc.run(docId, TENANT_ID, String(k.knowledgeName || k.kindName || "话术"), "text", content, String(k.kindName || k.knowledgeName || "话术") || null,
        sid, String(k.keyContent ?? ""), String(k.kindCode ?? ""), k.necessity ?? null, k.score ?? null, k.status ?? null,
        Array.isArray(k.tagIds) ? k.tagIds.join(",") : (k.tagIds != null ? String(k.tagIds) : null),
        JSON.stringify(k.kindList || []), String(k.custId ?? ""));
      insChunk.run(chunkId, TENANT_ID, docId, 0, content);
      inserted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { inserted, skipped };
}

function importConversations(db) {
  let inserted = 0, skipped = 0, customers = 0;
  const files = fs.readdirSync(FORMAT_DIR).filter((f) => f.endsWith(".json")).sort();
  const hasConv = db.prepare("SELECT id FROM conversations WHERE tenant_id = ? AND source_id = ?");
  const insCust = db.prepare("INSERT OR IGNORE INTO customers (id, tenant_id, key, name, phone) VALUES (?,?,?,?,?)");
  const insConv = db.prepare(
    "INSERT INTO conversations (id, tenant_id, customer_id, sales_name, sales_id, message_count, created_at, updated_at, channel, source_id, audio_date, complex_url, info_json, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insMsg = db.prepare(
    "INSERT INTO conversation_messages (id, tenant_id, conversation_id, seq, speaker_role, speaker_name, content, spoken_at, start_ms, end_ms, speaker) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const f of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(FORMAT_DIR, f), "utf8"));
      const d = doc.data || doc;
      const arr = Array.isArray(d.dialogListById) ? d.dialogListById : [];
      for (const conv of arr) {
        const sid = String(conv.id ?? "");
        if (!sid || hasConv.get(TENANT_ID, sid)) { skipped++; continue; }
        const infoList = Array.isArray(conv.infoList) ? conv.infoList : [];
        const clue = (infoList.find((x) => x.code === "clueId")?.valueList || [])[0] || "";
        const custKey = clue ? "c_" + clue : "c_" + sid;
        const custId = "cust_" + custKey.replace(/[^\w-]/g, "_");
        insCust.run(custId, TENANT_ID, custKey, fakeName(custKey), fakePhone(custKey));
        customers++;
        const convId = "conv_" + sid;
        const msgs = Array.isArray(conv.dialogList) ? conv.dialogList : [];
        const now = new Date().toISOString();
        insConv.run(convId, TENANT_ID, custId, SALES_NAME, SALES_ID, msgs.length, now, now, "phone", sid,
          String(conv.audioDate || ""), String(conv.complexUrl || ""),
          JSON.stringify(infoList), JSON.stringify(conv));
        msgs.forEach((m, idx) => {
          const role = Number(m.roleType) === 1 ? "sales" : Number(m.roleType) === 2 ? "customer" : "other";
          insMsg.run("msg_" + sid + "_" + idx, TENANT_ID, convId, idx + 1, role, role === "sales" ? SALES_NAME : null,
            String(m.text ?? ""), null, m.start != null ? Number(m.start) : null, m.end != null ? Number(m.end) : null, String(m.speaker ?? ""));
        });
        inserted++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { inserted, skipped, customers };
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 30000;");
    ensureColumns(db);
    clearAll(db);
    ensureTenantAndSales(db);
    const k = importPlaybook(db);
    const c = importConversations(db);
    const counts = {};
    for (const t of ["tenants", "customers", "conversations", "conversation_messages", "knowledge_documents", "knowledge_chunks"]) {
      counts[t] = db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
    }
    console.log("话术点: 新增 " + k.inserted + ", 跳过 " + k.skipped);
    console.log("对话: 新增 " + c.inserted + ", 跳过 " + c.skipped + ", 新增客户 " + c.customers);
    console.log("落库统计: " + JSON.stringify(counts));
  } finally {
    db.close();
  }
}
main().catch((e) => { console.error("导入失败: " + (e && e.message ? e.message : e)); process.exit(1); });
