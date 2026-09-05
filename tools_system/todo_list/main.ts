interface TodoItem {
    id: string;        // 层级ID，如 "1", "1.1", "1.2.1"
    event: string;
    solved: boolean;
    parentId?: string; // 父级ID
}

let TODO_LIST: TodoItem[] = [];
let TODO_LIST_MAP: Map<string, number> = new Map(); // id -> 数组索引

export function createTodoList(inputString: string): TodoItem[] {
    // 将 input_string 按换行符分隔 每一行为一个todo
    // 最终返回 TODO_LIST, 按换行符分隔，过滤掉空行
    // interface TodoItem {
    //     id: string;        // 层级ID，如 "1", "1.1", "1.2.1"
    //     event: string;
    //     solved: boolean;
    //     parentId?: string; // 父级ID
    // }
    // let TODO_LIST: TodoItem[] = [];
    
    const lines = inputString.split('\n').filter(line => line.trim() !== '');
    
    for (let i = 0; i < lines.length; i++) {
        const id = `${i + 1}`;
        TODO_LIST.push({
            id: id,
            event: lines[i].trim(),
            solved: false
        });
        TODO_LIST_MAP.set(id, TODO_LIST.length - 1);
    }
    
    return TODO_LIST;
}

export function detailTodoList(inputString: string, index: number): TodoItem[] {
    // 将现有的 TODO_LIST 中的某一步进行细化
    // index 是从 0 开始的索引
    
    // 检查索引是否有效
    if (index < 0 || index >= TODO_LIST.length) {
        throw new Error(`索引 ${index} 超出范围，当前共有 ${TODO_LIST.length} 个待办事项`);
    }
    
    // 获取要细化的原始任务
    const parentTask = TODO_LIST[index];
    const parentId = parentTask.id;
    
    // 按换行符分隔细化内容，过滤掉空行
    const details = inputString.split('\n').filter(line => line.trim() !== '');
    
    // 如果细化内容为空，返回空数组
    if (details.length === 0) {
        return TODO_LIST;
    }
    
    // 计算当前父级下已有的子任务数量
    const existingChildren = TODO_LIST.filter(item => item.parentId === parentId);
    let childCounter = existingChildren.length;
    
    // 添加子任务
    for (const detail of details) {
        childCounter++;
        const childId = `${parentId}.${childCounter}`;
        TODO_LIST.push({
            id: childId,
            event: detail.trim(),
            solved: false,
            parentId: parentId
        });
        TODO_LIST_MAP.set(childId, TODO_LIST.length - 1);
    }
    
    // 更新父任务描述
    parentTask.event = `${parentTask.event} (已细化，共${details.length}个子任务)`;
    
    return TODO_LIST;
}

export function finishTodoList(index_list: string[]): TodoItem[] {
    // 根据层级ID列表完成对应的待办事项
    // 例如: ["1.1", "1.2", "2"] 
    
    for (const id of index_list) {
        // 检查ID是否存在
        if (!TODO_LIST_MAP.has(id)) {
            console.warn(`ID ${id} 不存在，跳过`);
            continue;
        }
        
        const index = TODO_LIST_MAP.get(id)!;
        TODO_LIST[index].solved = true;
        
        // 递归完成所有子任务
        const children = TODO_LIST.filter(item => item.parentId === id);
        for (const child of children) {
            const childIndex = TODO_LIST_MAP.get(child.id)!;
            TODO_LIST[childIndex].solved = true;
        }
    }
    
    return TODO_LIST;
}

// ── 外部工具契约适配:execute(ctx, params) ──
// params.op: create(默认, inputString)/ detail(inputString+index)/ finish(indexList)
export function execute(_ctx: unknown, params: any) {
	const op = params?.op ?? "create";
	if (op === "detail") {
		const r = detailTodoList(String(params.inputString ?? ""), Number(params.index ?? 0));
		return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: { todoList: r } };
	}
	if (op === "finish") {
		const ids = Array.isArray(params?.indexList) ? params.indexList : Array.isArray(params?.index_list) ? params.index_list : [];
		const r = finishTodoList(ids as string[]);
		return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: { todoList: r } };
	}
	const r = createTodoList(String(params?.inputString ?? ""));
	return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: { todoList: r } };
}