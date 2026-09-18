import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { textVector } from "./text-vec.js";

/** 本地轻量中文 BGE 模型(Xenova/bge-small-zh-v1.5,ONNX,约 25MB),缓存在仓库 data/models。 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BGE_MODEL_DIR = path.join(repoRoot, "data", "models");
export const BGE_MODEL_ID = "Xenova/bge-small-zh-v1.5";

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function initBgePipeline(): Promise<FeatureExtractionPipeline> {
	if (pipelinePromise) return pipelinePromise;
	env.cacheDir = BGE_MODEL_DIR;
	env.localModelPath = BGE_MODEL_DIR; // 离线模式(v3)从该目录加载模型文件
	env.allowRemoteModels = false; // 只用本地文件;模型未下载时快速失败,由调用方回退到 n-gram 向量
	pipelinePromise = pipeline("feature-extraction", BGE_MODEL_ID).catch((error) => {
		pipelinePromise = null; // 允许后续重试
		throw error;
	});
	return pipelinePromise;
}

/** 用本地 BGE 模型把文本批量转为 L2 归一化向量(mean pooling);模型不可用时抛错。 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
	const clean = texts.map((t) => String(t ?? "")).filter((t) => t.trim().length > 0);
	if (clean.length === 0) return [];
	const pipe = await initBgePipeline();
	const output = await pipe(clean, { pooling: "mean", normalize: true });
	const flat = Array.from(output.data as Float32Array);
	const hidden = output.dims[output.dims.length - 1] || flat.length;
	const vecs: number[][] = [];
	for (let i = 0; i < clean.length; i++) {
		vecs.push(flat.slice(i * hidden, (i + 1) * hidden));
	}
	return vecs;
}

/** BGE 优先;模型缺失/加载失败时回退到字符 n-gram 向量,保证功能不中断。 */
export async function embedTextsSafe(texts: string[]): Promise<number[][]> {
	try {
		return await embedTexts(texts);
	} catch {
		return texts.map((t) => textVector(String(t ?? "")));
	}
}
