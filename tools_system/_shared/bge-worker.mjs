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

// 在主线程和子线程之间通过消息传递，异步完成文本向量化（embedding）计算，并把结果回传。
// parentPort：是 worker_threads 模块提供的对象，代表当前子线程与主线程通信的端口。
// .on("message", handler)：监听主线程通过 worker.postMessage(...) 发来的消息。
// async (msg) => {}：回调是异步函数，因为内部要 await 模型推理。
// 入参解构：const { id, texts } = msg || {};
// msg 通常是主线程发来的对象，形如：{ id: 123, texts: ["你好", "世界"] }
// msg || {}：如果 msg 是 undefined / null / 0 / ""，就退化成 {}，避免解构时报 Cannot destructure property 'id' of undefined。
// 它等价于：
// const id = msg.id;
// const texts = msg.texts;
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
