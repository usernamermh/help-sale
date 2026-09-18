// 下载轻量中文 BGE 模型到本地缓存(data/models),供 @huggingface/transformers 离线使用。
// 运行: node scripts/download-bge.mjs(需要能访问 hf-mirror.com)
import { env, pipeline } from "@huggingface/transformers";
import path from "node:path";
import { fileURLToPath } from "node:url";

env.remoteHost = "https://hf-mirror.com"; // 国内镜像
env.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "models");
env.allowRemoteModels = true;

const pipe = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
const out = await pipe(["你好,测试一下", "汉EV 冠军版性价比很高"], { pooling: "mean", normalize: true });
console.log("BGE 模型下载完成,向量维度: " + out.dims[out.dims.length - 1]);
console.log("缓存目录: " + env.cacheDir);
