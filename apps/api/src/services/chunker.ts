export interface ChunkerOptions {
	size?: number;
	overlap?: number;
}

export function splitText(text: string, options: ChunkerOptions = {}): string[] {
	const size = options.size ?? 600;
	const overlap = options.overlap ?? 80;
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length === 0) return [];

	const paragraphs = normalized.split(/\n\s*\n/);
	const chunks: string[] = [];
	let buffer = "";

	for (const paragraph of paragraphs) {
		const trimmed = paragraph.trim();
		if (trimmed.length === 0) continue;

		const candidate = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
		if (candidate.length <= size) {
			buffer = candidate;
			continue;
		}

		if (buffer) {
			chunks.push(buffer);
			buffer = "";
		}

		let rest = trimmed;
		while (rest.length > size) {
			const head = rest.slice(0, size);
			chunks.push(head);
			rest = rest.slice(size - overlap);
		}
		buffer = rest;
	}
	if (buffer) chunks.push(buffer);
	return chunks;
}