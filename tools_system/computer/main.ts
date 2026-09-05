interface ToolContext { db: any; tenantId: string; }

// 安全的数值表达式求值:仅词法白名单(数字/运算符/括号/变量名),不用 eval。
function tokenize(expr: string): string[] {
	const tokens: string[] = [];
	for (let i = 0; i < expr.length; ) {
		const ch = expr[i];
		if (/\s/.test(ch)) { i++; continue; }
		if (/[0-9.]/.test(ch)) {
			let j = i;
			while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
			tokens.push(expr.slice(i, j));
			i = j;
			continue;
		}
		if (/[+\-*/%()]/.test(ch)) { tokens.push(ch); i++; continue; }
		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
			tokens.push(expr.slice(i, j));
			i = j;
			continue;
		}
		throw new Error(`非法字符:${ch}`);
	}
	return tokens;
}

export function execute(ctx: ToolContext, params: any) {
	const expr = String(params?.expression ?? "").trim();
	if (!expr) return { content: [{ type: "text", text: "请提供 expression 表达式。" }] };
	const vars: Record<string, number> = (params?.variables && typeof params.variables === "object") ? (params.variables as Record<string, number>) : {};
	const tk = tokenize(expr);
	let pos = 0;
	const peek = () => tk[pos];
	const next = (): string => tk[pos++];
	function parseExpr(): number {
		let v = parseTerm();
		while (peek() === "+" || peek() === "-") { const op = next(); const r = parseTerm(); v = op === "+" ? v + r : v - r; }
		return v;
	}
	function parseTerm(): number {
		let v = parseFactor();
		while (peek() === "*" || peek() === "/" || peek() === "%") { const op = next(); const r = parseFactor(); v = op === "*" ? v * r : op === "/" ? v / r : v % r; }
		return v;
	}
	function parseFactor(): number {
		const t = next();
		if (t === undefined) throw new Error("表达式不完整");
		if (t === "(") { const v = parseExpr(); if (next() !== ")") throw new Error("缺少右括号"); return v; }
		if (t === "-") return -parseFactor();
		if (t === "+") return parseFactor();
		if (/^[0-9.]/.test(t)) { const n = Number(t); if (!Number.isFinite(n)) throw new Error(`非法数字:${t}`); return n; }
		if (/^[A-Za-z_]/.test(t)) { const v = vars[t]; if (typeof v !== "number") throw new Error(`未知变量:${t}`); return v; }
		throw new Error(`非法 token:${t}`);
	}
	const result = parseExpr();
	if (pos !== tk.length) throw new Error(`多余内容:${tk.slice(pos).join("")}`);
	return { content: [{ type: "text", text: `计算结果: ${expr} = ${result}` }], details: { expression: expr, result } };
}