/**
 * QRLite —— 自包含的二维码编码器(字节模式,版本 1-10,纠错等级 L/M/Q/H,自动选版本与掩码)。
 * 只做前端渲染微信登录二维码用:不依赖任何外部库与网络,输出布尔矩阵后自行画到 canvas/SVG。
 */
(function (root) {
	"use strict";

	var ECC_CODEWORDS_PER_BLOCK = [
		[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
		[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
		[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
		[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	];
	var NUM_ERROR_CORRECTION_BLOCKS = [
		[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
		[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
		[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
		[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
	];
	var ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
	var ECC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

	function numRawDataModules(version) {
		var result = (16 * version + 128) * version + 64;
		if (version >= 2) {
			var numAlign = Math.floor(version / 7) + 2;
			result -= (25 * numAlign - 10) * numAlign - 55;
			if (version >= 7) result -= 36;
		}
		return result;
	}

	function numDataCodewords(version, level) {
		var index = ECC_LEVEL_INDEX[level];
		return (
			Math.floor(numRawDataModules(version) / 8) -
			ECC_CODEWORDS_PER_BLOCK[index][version] * NUM_ERROR_CORRECTION_BLOCKS[index][version]
		);
	}

	function alignmentPatternPositions(version) {
		if (version === 1) return [];
		var numAlign = Math.floor(version / 7) + 2;
		var step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
		var result = [6];
		for (var pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	// ── GF(256) 运算与 Reed-Solomon ──
	function gfMultiply(x, y) {
		var z = 0;
		for (var i = 7; i >= 0; i--) {
			z = (z << 1) ^ ((z >>> 7) * 0x11d);
			z ^= ((y >>> i) & 1) * x;
		}
		return z & 0xff;
	}

	function reedSolomonComputeDivisor(degree) {
		var result = [];
		for (var i = 0; i < degree - 1; i++) result.push(0);
		result.push(1);
		var root = 1;
		for (var i2 = 0; i2 < degree; i2++) {
			for (var j = 0; j < result.length; j++) {
				result[j] = gfMultiply(result[j], root);
				if (j + 1 < result.length) result[j] ^= result[j + 1];
			}
			root = gfMultiply(root, 0x02);
		}
		return result;
	}

	function reedSolomonComputeRemainder(data, divisor) {
		var result = divisor.map(function () {
			return 0;
		});
		data.forEach(function (b) {
			var factor = b ^ result.shift();
			result.push(0);
			divisor.forEach(function (coef, i) {
				result[i] ^= gfMultiply(coef, factor);
			});
		});
		return result;
	}

	function toUtf8Bytes(text) {
		var out = [];
		var str = String(text);
		for (var i = 0; i < str.length; i++) {
			var code = str.charCodeAt(i);
			if (code < 0x80) out.push(code);
			else if (code < 0x800) {
				out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
			} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
				var next = str.charCodeAt(++i);
				var cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
			} else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		}
		return out;
	}

	/** 组装数据码字(字节模式 + 终止符 + 补位)。 */
	function buildDataCodewords(bytes, version, level) {
		var capacityBits = numDataCodewords(version, level) * 8;
		var bits = [];
		var push = function (value, length) {
			for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
		};
		push(0x4, 4); // 字节模式
		push(bytes.length, version <= 9 ? 8 : 16);
		bytes.forEach(function (b) {
			push(b, 8);
		});
		push(0, Math.min(4, capacityBits - bits.length));
		push(0, (8 - (bits.length % 8)) % 8);
		for (var pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
		var codewords = [];
		for (var i = 0; i < bits.length; i += 8) {
			var value = 0;
			for (var j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
			codewords.push(value);
		}
		return codewords;
	}

	/** 按块纠错并交错输出最终码字序列。 */
	function addEccAndInterleave(data, version, level) {
		var index = ECC_LEVEL_INDEX[level];
		var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[index][version];
		var blockEccLen = ECC_CODEWORDS_PER_BLOCK[index][version];
		var rawCodewords = Math.floor(numRawDataModules(version) / 8);
		var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
		var shortBlockLen = Math.floor(rawCodewords / numBlocks);
		var divisor = reedSolomonComputeDivisor(blockEccLen);
		var blocks = [];
		var dataOffset = 0;
		for (var i = 0; i < numBlocks; i++) {
			var dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
			var dat = data.slice(dataOffset, dataOffset + dataLen);
			dataOffset += dataLen;
			var ecc = reedSolomonComputeRemainder(dat, divisor);
			if (i < numShortBlocks) dat.push(0);
			blocks.push(dat.concat(ecc));
		}
		var result = [];
		for (var i2 = 0; i2 < blocks[0].length; i2++) {
			blocks.forEach(function (block, j) {
				if (i2 !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i2]);
			});
		}
		return result;
	}

	/** 画出功能图形,返回模块矩阵与占用标记。 */
	function createBase(version) {
		var size = version * 4 + 17;
		var modules = [];
		var isFunction = [];
		for (var y = 0; y < size; y++) {
			modules.push(new Array(size).fill(false));
			isFunction.push(new Array(size).fill(false));
		}
		var setFunction = function (x, y, dark) {
			if (x < 0 || y < 0 || x >= size || y >= size) return;
			modules[y][x] = dark;
			isFunction[y][x] = true;
		};
		var drawFinder = function (cx, cy) {
			for (var dy = -4; dy <= 4; dy++) {
				for (var dx = -4; dx <= 4; dx++) {
					var dist = Math.max(Math.abs(dx), Math.abs(dy));
					setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
				}
			}
		};
		// 顺序与规范一致:先画时间图形,再让三个定位图形覆盖它
		for (var i = 0; i < size; i++) {
			setFunction(6, i, i % 2 === 0);
			setFunction(i, 6, i % 2 === 0);
		}
		drawFinder(3, 3);
		drawFinder(size - 4, 3);
		drawFinder(3, size - 4);
		var positions = alignmentPatternPositions(version);
		for (var a = 0; a < positions.length; a++) {
			for (var b = 0; b < positions.length; b++) {
				var isCorner = (a === 0 && b === 0) || (a === 0 && b === positions.length - 1) || (a === positions.length - 1 && b === 0);
				if (isCorner) continue;
				for (var dy2 = -2; dy2 <= 2; dy2++) {
					for (var dx2 = -2; dx2 <= 2; dx2++) {
						setFunction(positions[b] + dx2, positions[a] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
					}
				}
			}
		}
		// 预留格式信息与版本信息的模块位(这些位置不参与数据填充)
		for (var k = 0; k <= 8; k++) {
			if (k === 6) continue; // 第 6 行/列是时间图形,不属于格式信息
			setFunction(8, k, false);
			setFunction(k, 8, false);
		}
		for (var m = 0; m < 8; m++) {
			setFunction(8, size - 1 - m, false);
			setFunction(size - 1 - m, 8, false);
		}
		if (version >= 7) {
			for (var v = 0; v < 6; v++) {
				for (var w = 0; w < 3; w++) {
					setFunction(size - 11 + w, v, false);
					setFunction(v, size - 11 + w, false);
				}
			}
		}
		return { size: size, modules: modules, isFunction: isFunction, setFunction: setFunction };
	}

	// ── 掩码与惩罚分 ──
	function maskAt(mask, x, y) {
		switch (mask) {
			case 0: return (x + y) % 2 === 0;
			case 1: return y % 2 === 0;
			case 2: return x % 3 === 0;
			case 3: return (x + y) % 3 === 0;
			case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
			case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
			case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
			case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
			default: throw new Error("mask out of range");
		}
	}

	function penaltyScore(modules, size) {
		var score = 0;
		var i, j;
		// 行/列连续同色
		for (i = 0; i < size; i++) {
			for (var dir = 0; dir < 2; dir++) {
				var runColor = false;
				var runLen = 0;
				for (j = 0; j < size; j++) {
					var color = dir === 0 ? modules[i][j] : modules[j][i];
					if (color === runColor) {
						runLen++;
						if (runLen === 5) score += 3;
						else if (runLen > 5) score++;
					} else {
						runColor = color;
						runLen = 1;
					}
				}
			}
		}
		// 2x2 同色块
		for (i = 0; i < size - 1; i++) {
			for (j = 0; j < size - 1; j++) {
				var c = modules[i][j];
				if (c === modules[i][j + 1] && c === modules[i + 1][j] && c === modules[i + 1][j + 1]) score += 3;
			}
		}
		// 类似定位图形的 1:1:3:1:1 模式(两侧至少一侧是 4 个浅色)
		var pattern = [true, false, true, true, true, false, true];
		var allLight = function (get, from, to) {
			for (var k = from; k <= to; k++) if (get(k)) return false;
			return true;
		};
		for (i = 0; i < size; i++) {
			for (j = 0; j <= size - 7; j++) {
				var rowGet = (function (row) {
					return function (idx) {
						return modules[row][idx];
					};
				})(i);
				var colGet = (function (col) {
					return function (idx) {
						return modules[idx][col];
					};
				})(i);
				var hitRow = true;
				var hitCol = true;
				for (var k2 = 0; k2 < 7; k2++) {
					if (rowGet(j + k2) !== pattern[k2]) hitRow = false;
					if (colGet(j + k2) !== pattern[k2]) hitCol = false;
				}
				if (hitRow && ((j - 4 >= 0 && allLight(rowGet, j - 4, j - 1)) || (j + 10 < size && allLight(rowGet, j + 7, j + 10)))) score += 40;
				if (hitCol && ((j - 4 >= 0 && allLight(colGet, j - 4, j - 1)) || (j + 10 < size && allLight(colGet, j + 7, j + 10)))) score += 40;
			}
		}		// 深色比例
		var dark = 0;
		for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (modules[i][j]) dark++;
		var total = size * size;
		var k3 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		score += Math.max(0, k3) * 10;
		return score;
	}

	function bchFormat(data) {
		var rem = data;
		for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		return ((data << 10) | rem) ^ 0x5412;
	}

	function bchVersion(version) {
		var rem = version;
		for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		return (version << 12) | rem;
	}

	function drawFormatBitsOn(matrix, size, level, mask) {
		var data = (ECC_FORMAT_BITS[level] << 3) | mask;
		var bits = bchFormat(data);
		for (var i = 0; i <= 5; i++) matrix[i][8] = ((bits >>> i) & 1) !== 0;
		matrix[7][8] = ((bits >>> 6) & 1) !== 0;
		matrix[8][8] = ((bits >>> 7) & 1) !== 0;
		matrix[8][7] = ((bits >>> 8) & 1) !== 0;
		for (var j = 9; j < 15; j++) matrix[8][14 - j] = ((bits >>> j) & 1) !== 0;
		// 第二份格式信息:bit0-7 沿第 8 行向右,bit8-14 沿第 8 列向下(行/列方向与第一份相反)
		for (var k = 0; k < 8; k++) matrix[8][size - 1 - k] = ((bits >>> k) & 1) !== 0;
		for (var m = 8; m < 15; m++) matrix[size - 15 + m][8] = ((bits >>> m) & 1) !== 0;
		matrix[size - 8][8] = true;
	}

	function drawVersionBitsOn(matrix, size, version) {
		if (version < 7) return;
		var bits = bchVersion(version);
		for (var i = 0; i < 18; i++) {
			var bit = ((bits >>> i) & 1) !== 0;
			var a = size - 11 + (i % 3);
			var b = Math.floor(i / 3);
			matrix[a][b] = bit;
			matrix[b][a] = bit;
		}
	}

	/** 生成二维码模块矩阵(含静默区可选)。 */
	function matrix(text, options) {
		var opts = options || {};
		var level = String(opts.ecc || "M").toUpperCase();
		if (!(level in ECC_FORMAT_BITS)) throw new Error("不支持的纠错等级: " + level);
		var bytes = toUtf8Bytes(text);
		var version = opts.version || 0;
		if (!version) {
			version = 1;
			while (version <= 40 && (4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > numDataCodewords(version, level) * 8)) version++;
			if (version > 40) throw new Error("内容过长,超出本编码器支持(版本 40): " + bytes.length + " 字节");
		}
		if (bytes.length > numDataCodewords(version, level)) throw new Error("内容超出所选版本容量");
		var data = buildDataCodewords(bytes, version, level);
		var codewords = addEccAndInterleave(data, version, level);
		var size = version * 4 + 17;
		var base = createBase(version);
		drawVersionBitsOn(base.modules, size, version);

		// 数据区:从右下角开始蛇形填充
		var bitIndex = 0;
		var totalBits = codewords.length * 8;
		for (var right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (var vert = 0; vert < size; vert++) {
				for (var j = 0; j < 2; j++) {
					var x = right - j;
					var upward = ((right + 1) & 2) === 0;
					var y = upward ? size - 1 - vert : vert;
					if (base.isFunction[y][x]) continue;
					if (bitIndex < totalBits) {
						var byte = codewords[bitIndex >>> 3];
						base.modules[y][x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
						bitIndex++;
					}
				}
			}
		}

		var bestMask = opts.mask;
		if (bestMask === undefined || bestMask === null) {
			var bestScore = Infinity;
			for (var mask = 0; mask < 8; mask++) {
				var candidate = base.modules.map(function (row) {
					return row.slice();
				});
				applyMask(candidate, base.isFunction, size, mask);
				drawFormatBitsOn(candidate, size, level, mask);
				var score = penaltyScore(candidate, size);
				if (score < bestScore) {
					bestScore = score;
					bestMask = mask;
				}
			}
		}
		applyMask(base.modules, base.isFunction, size, bestMask);
		drawFormatBitsOn(base.modules, size, level, bestMask);
		return base.modules;
	}

	function applyMask(modules, isFunction, size, mask) {
		for (var y = 0; y < size; y++) {
			for (var x = 0; x < size; x++) {
				if (isFunction[y][x]) continue;
				if (maskAt(mask, x, y)) modules[y][x] = !modules[y][x];
			}
		}
	}

	/** 画到 canvas;返回实际使用的像素边长。 */
	function drawToCanvas(canvas, text, options) {
		var opts = options || {};
		var quiet = opts.quietZone === undefined ? 4 : opts.quietZone;
		var scale = opts.scale || 6;
		var modules = matrix(text, opts);
		var size = modules.length;
		var pixels = (size + quiet * 2) * scale;
		canvas.width = pixels;
		canvas.height = pixels;
		var ctx = canvas.getContext("2d");
		ctx.fillStyle = opts.light || "#ffffff";
		ctx.fillRect(0, 0, pixels, pixels);
		ctx.fillStyle = opts.dark || "#111827";
		for (var y = 0; y < size; y++) {
			for (var x = 0; x < size; x++) {
				if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
			}
		}
		return pixels;
	}

	var QRLite = { matrix: matrix, drawToCanvas: drawToCanvas, version: "1.0.0" };
	if (typeof module === "object" && module.exports) module.exports = QRLite;
	if (root) root.QRLite = QRLite;
})(typeof globalThis !== "undefined" ? globalThis : this);