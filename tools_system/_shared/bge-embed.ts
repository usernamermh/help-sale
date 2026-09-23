import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { textVector } from "./text-vec.js";

/** 本地轻量中文 BGE 模型(Xenova/bge-small-zh-v1.5,ONNX,约 25MB),缓存在仓库 data/models。 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BGE_MODEL_DIR = path.join(repoRoot, "data", "models");
export const BGE_MODEL_ID = "Xenova/bge-small-zh-v1.5";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (vecs: number[][]) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
	if (worker) return worker;
	const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "bge-worker.mjs");
	worker = new Worker(workerPath);
	worker.on("message", (msg: { id: number; ok: boolean; vecs?: number[][]; error?: string }) => {
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.vecs ?? []);
		else p.reject(new Error(msg.error ?? "embedding worker error"));
	});
	worker.on("error", (error) => {
		for (const [, p] of pending) p.reject(error);
		pending.clear();
		worker = null;
	});
	worker.on("exit", () => {
		for (const [, p] of pending) p.reject(new Error("embedding worker exited"));
		pending.clear();
		worker = null;
	});
	return worker;
}

/** 用本地 BGE 模型把文本批量转为 L2 归一化向量(mean pooling);在 Worker 线程推理,不阻塞主线程事件循环。 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
	const clean = texts.map((t) => String(t ?? "")).filter((t) => t.trim().length > 0);
	if (clean.length === 0) return [];
	return new Promise<number[][]>((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve, reject });
		getWorker().postMessage({ id, texts: clean });
	});
}

export async function embedTextsSafe(texts: string[]): Promise<number[][]> {
	try {
		return await embedTexts(texts);
	} catch {
		return texts.map((t) => textVector(String(t ?? "")));
	}
}
