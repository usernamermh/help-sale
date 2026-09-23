/**
 * BGE embedding worker:在主线程之外加载/推理本地 bge-small-zh 模型,
 * 避免 onnxruntime 在 Node 主线程同步推理阻塞事件循环(页面/看板请求不被卡住)。
 */
import { parentPort } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BGE_MODEL_DIR = path.join(repoRoot, "data", "models");
const BGE_MODEL_ID = "Xenova/bge-small-zh-v1.5";

let pipe = null;

async function getPipe() {
  if (!pipe) {
    env.cacheDir = BGE_MODEL_DIR;
    env.localModelPath = BGE_MODEL_DIR; // 离线模式:从该目录加载模型文件
    env.allowRemoteModels = false; // 只用本地文件
    pipe = await pipeline("feature-extraction", BGE_MODEL_ID);
  }
  return pipe;
}

parentPort.on("message", async (msg) => {
  const { id, texts } = msg || {};
  try {
    const p = await getPipe();
    const output = await p(texts, { pooling: "mean", normalize: true });
    const flat = Array.from(output.data);
    const hidden = output.dims[output.dims.length - 1] || flat.length;
    const vecs = [];
    for (let i = 0; i < texts.length; i++) vecs.push(flat.slice(i * hidden, (i + 1) * hidden));
    parentPort.postMessage({ id, ok: true, vecs });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
