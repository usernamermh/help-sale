import { record } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { MilvusDeployConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `milvus_backend` 与 `milvus_docker_compose` 两段:
 *   milvus_backend        → Milvus 服务端配置覆盖(落成 user.yaml,与镜像内 milvus.yaml 合并)
 *   milvus_docker_compose → Milvus standalone + etcd 的 compose 定义(落成 docker-compose.yml)
 *
 * 这两段整体是部署清单,结构随 Milvus 版本变化,所以按"键值映射"整体校验后原样透出;
 * 代码不补任何字段、不设默认值 —— 缺了这两段直接报错,内容由配置文件负责说清楚。
 */
export function loadMilvusDeployConfig(file: FileConfig): MilvusDeployConfig {
	return {
		milvusBackend: record(file.milvus_backend, "milvus_backend"),
		milvusDockerCompose: record(file.milvus_docker_compose, "milvus_docker_compose"),
	};
}
