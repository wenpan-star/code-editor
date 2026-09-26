// filename: js/encoding.js
/**
 * ============================================================================
 * encoding.js — 编码统一入口 + UTF-8 / BOM / ANSI / GBK / ASCII
 * ============================================================================
 *
 * 【本次重构】
 *   1. bindEncodingSelectEvents 的 Toast 增强（编码标准合规性）：
 *      原实现在用户切换编码后只显示"编码格式已切换为 X"，
 *      没有告知用户 'ansi' 在当前环境下的实际编码。
 *
 *      新行为：
 *        · 若用户选择 'ansi'，Toast 追加 "（当前环境实际使用 GBK/ASCII）"；
 *        · 若用户选择 'gbk' 但浏览器不支持，Toast 追加 "（浏览器不支持）"；
 *        · 其他编码保持原简短提示。
 *      这样用户无需查阅文档就能理解 ANSI 的妥协语义。
 *
 *   2. updateEncodingDisplay 与 updateEncodingStatusOnly 保持不变：
 *      · 状态栏仍用简短显示名（ENCODING_DISPLAY_NAMES）；
 *      · 详细描述由 index.html 的 option title 与本次 Toast 承担。
 *
 *   3. 保留全部原有导出接口与行为：
 *      detectBOMEncoding / stripBOMFromArrayBuffer / isValidUTF8 /
 *      encodeTextToAscii / encodeTextToAnsi / decodeTextFromAnsi /
 *      resolveActualAnsiEncoding / encodeTextToBytes / decodeTextFromBytes /
 *      updateEncodingDisplay / updateEncodingStatusOnly /
 *      initializeEncodingSettings / bindEncodingSelectEvents。
 * ============================================================================
 */

import { EditorState } from './state.js';
import {
    STORAGE_KEYS,
    ENCODING_DISPLAY_NAMES,
    ENCODING_LONG_DESCRIPTIONS
} from './config.js';
import { saveToLocalStorage, loadFromLocalStorage } from './util.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import {
    isGBKSupported,
    encodeTextToGBK,
    decodeTextFromGBK
} from './gbk-codec.js';

// ==================== BOM 检测与剥离 ====================

/**
 * 检测字节流开头的 BOM。
 * 仅保留 UTF-8 BOM 检测。
 */
export function detectBOMEncoding(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return 'utf-8-bom';
    }
    return null;
}

/**
 * 剥离指定编码的 BOM。
 * 仅处理 UTF-8 BOM。
 */
export function stripBOMFromArrayBuffer(arrayBuffer, encoding) {
    const bytes = new Uint8Array(arrayBuffer);
    let bomLength = 0;
    if (encoding === 'utf-8-bom'
        && bytes.length >= 3
        && bytes[0] === 0xEF
        && bytes[1] === 0xBB
        && bytes[2] === 0xBF) {
        bomLength = 3;
    }
    if (bomLength === 0) return arrayBuffer;
    return arrayBuffer.slice(bomLength);
}

/**
 * 检查字节流是否为有效 UTF-8。
 * 用于导入文件时，在「自动检测」模式下判断字节流是否符合 UTF-8 规范；
 * 若不符合，提示用户可能是其他编码。
 */
export function isValidUTF8(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let index = 0;
    while (index < bytes.length) {
        const byte1 = bytes[index];
        if (byte1 <= 0x7F) {
            index += 1;
        } else if (byte1 >= 0xC2 && byte1 <= 0xDF) {
            if (index + 1 >= bytes.length) return false;
            const byte2 = bytes[index + 1];
            if ((byte2 & 0xC0) !== 0x80) return false;
            index += 2;
        } else if (byte1 >= 0xE0 && byte1 <= 0xEF) {
            if (index + 2 >= bytes.length) return false;
            const byte2 = bytes[index + 1];
            const byte3 = bytes[index + 2];
            if ((byte2 & 0xC0) !== 0x80 || (byte3 & 0xC0) !== 0x80) return false;
            if (byte1 === 0xE0 && byte2 < 0xA0) return false;
            if (byte1 === 0xED && byte2 > 0x9F) return false;
            index += 3;
        } else if (byte1 >= 0xF0 && byte1 <= 0xF4) {
            if (index + 3 >= bytes.length) return false;
            const byte2 = bytes[index + 1];
            const byte3 = bytes[index + 2];
            const byte4 = bytes[index + 3];
            if ((byte2 & 0xC0) !== 0x80
                || (byte3 & 0xC0) !== 0x80
                || (byte4 & 0xC0) !== 0x80) return false;
            if (byte1 === 0xF0 && byte2 < 0x90) return false;
            if (byte1 === 0xF4 && byte2 > 0x8F) return false;
            index += 4;
        } else {
            return false;
        }
    }
    return true;
}

// ==================== 纯 ASCII 编码 ====================

/**
 * 将文本编码为纯 ASCII 字节数组。
 *
 * ASCII 是 UTF-8 的严格子集（0x00-0x7F）。
 * 非 ASCII 字符（含中文、全角符号）一律替换为 '?'（0x3F）。
 *
 * 代理对处理：
 *   BMP 外字符（如 emoji）在 UTF-16 中占用 2 个码元（高代理 + 低代理）。
 *   本函数将其视为一个逻辑字符，只替换为一个 '?'。
 */
export function encodeTextToAscii(text) {
    const byteArray = [];
    for (let index = 0; index < text.length; index++) {
        const charCode = text.charCodeAt(index);

        // 代理对（BMP 外字符）：占用 2 个 UTF-16 码元，替换为一个 '?'
        if (charCode >= 0xD800 && charCode <= 0xDBFF && index + 1 < text.length) {
            const nextCharCode = text.charCodeAt(index + 1);
            if (nextCharCode >= 0xDC00 && nextCharCode <= 0xDFFF) {
                byteArray.push(0x3F);
                index++;
                continue;
            }
        }

        // 0x00-0x7F 直通；其余替换为 '?'
        byteArray.push(charCode <= 0x7F ? charCode : 0x3F);
    }
    return new Uint8Array(byteArray);
}

// ==================== ANSI（系统默认）编码 ====================

/**
 * 将文本编码为 ANSI（系统默认编码）。
 *
 * ANSI 在不同语言环境下的含义：
 *   · 简体中文 Windows  → GBK（代码页 936）
 *   · 繁体中文 Windows  → Big5（代码页 950）
 *   · 日文 Windows      → Shift-JIS（代码页 932）
 *
 * 本编辑器面向中文用户为主，且浏览器沙箱无法探测操作系统 ANSI 代码页，
 * 因此实现策略：
 *   1. 若浏览器支持 GBK 解码 → 使用 GBK（覆盖简中场景）
 *   2. 否则                    → 回退到纯 ASCII（保底不崩溃，非 ASCII 替换为 '?'）
 *
 * 与 'gbk' 的关键差异：
 *   · 'gbk'   —— 不支持时硬报错，由调用方提示用户
 *   · 'ansi'  —— 不支持时静默回退 ASCII，符合"系统默认"的语义
 */
export function encodeTextToAnsi(text) {
    if (isGBKSupported()) {
        return encodeTextToGBK(text);
    }
    // GBK 不可用时回退到纯 ASCII（保底不崩溃）
    return encodeTextToAscii(text);
}

/**
 * 从 ArrayBuffer 解码为 ANSI 文本。
 * 优先使用 GBK 解码（简中 Windows 默认）；不支持时回退 UTF-8 解码器
 * （ASCII 是 UTF-8 严格子集，UTF-8 解码器可正确处理纯 ASCII 字节）。
 */
export function decodeTextFromAnsi(arrayBuffer) {
    if (isGBKSupported()) {
        return decodeTextFromGBK(arrayBuffer);
    }
    // ASCII 是 UTF-8 子集，UTF-8 解码器可正确处理
    return new TextDecoder('utf-8').decode(arrayBuffer);
}

/**
 * 判断给定的 'ansi' 编码在当前环境下实际使用的编码。
 *
 * 返回值：
 *   · 'gbk'    —— GBK 支持，'ansi' 实际走 GBK
 *   · 'ascii'  —— GBK 不支持，'ansi' 回退 ASCII
 */
export function resolveActualAnsiEncoding() {
    return isGBKSupported() ? 'gbk' : 'ascii';
}

// ==================== 统一编码入口 ====================

/**
 * 将文本编码为字节数组。
 *
 * 支持：utf-8 / utf-8-bom / ansi / gbk / ascii。
 * ANSI 与 GBK 均委托 gbk-codec.js（ANSI 内部有软回退）；
 * 其他编码在本模块内处理。
 *
 * @param {string} text
 * @param {string} encoding
 * @returns {Uint8Array}
 * @throws {Error} 当 encoding === 'gbk' 且浏览器不支持时抛出
 *                 （'ansi' 不会抛错，会静默回退 ASCII）
 */
export function encodeTextToBytes(text, encoding) {
    switch (encoding) {
        case 'utf-8':
            return new TextEncoder().encode(text);
        case 'utf-8-bom': {
            const encodedBytes = new TextEncoder().encode(text);
            const bomPrefixedBytes = new Uint8Array(3 + encodedBytes.length);
            bomPrefixedBytes[0] = 0xEF;
            bomPrefixedBytes[1] = 0xBB;
            bomPrefixedBytes[2] = 0xBF;
            bomPrefixedBytes.set(encodedBytes, 3);
            return bomPrefixedBytes;
        }
        case 'ansi':
            // 系统默认 ANSI：GBK 优先，不可用时静默回退 ASCII
            return encodeTextToAnsi(text);
        case 'gbk':
            // 明确 GBK：不支持时抛错，由调用方提示用户
            return encodeTextToGBK(text);
        case 'ascii':
            return encodeTextToAscii(text);
        default:
            // 未知 / 历史遗留编码值（含被移除的 windows-1252）：降级为 UTF-8。
            console.warn('未知编码值:', encoding, '，编码时已降级为 UTF-8');
            return new TextEncoder().encode(text);
    }
}

/**
 * 从字节数组解码为文本。
 *
 * 支持：utf-8 / utf-8-bom / ansi / gbk / ascii。
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} encoding
 * @returns {string}
 * @throws {Error} 当 encoding === 'gbk' 且浏览器不支持时抛出
 */
export function decodeTextFromBytes(arrayBuffer, encoding) {
    if (encoding === 'gbk') {
        return decodeTextFromGBK(arrayBuffer);
    }
    if (encoding === 'ansi') {
        return decodeTextFromAnsi(arrayBuffer);
    }

    const strippedBuffer = stripBOMFromArrayBuffer(arrayBuffer, encoding);

    // 'ascii' 解码用 UTF-8 解码器（ASCII 是 UTF-8 严格子集）。
    const decoderEncodingMap = {
        'utf-8': 'utf-8',
        'utf-8-bom': 'utf-8',
        'ascii': 'utf-8'
    };
    let decoderEncoding = decoderEncodingMap[encoding];
    if (!decoderEncoding) {
        console.warn('未知编码值:', encoding, '，解码时已降级为 UTF-8');
        decoderEncoding = 'utf-8';
    }

    try {
        const textDecoder = new TextDecoder(decoderEncoding);
        return textDecoder.decode(strippedBuffer);
    } catch (decodeError) {
        console.warn('编码解码失败，使用 UTF-8 回退:', decodeError);
        const fallbackDecoder = new TextDecoder('utf-8');
        return fallbackDecoder.decode(arrayBuffer);
    }
}

// ==================== UI 集成 ====================

/**
 * 更新编码下拉框与状态栏显示。
 *
 * 状态栏只显示编码名（如"自动检测"），不带任何前缀符号。
 * 同时更新 EditorState.currentEncoding 并持久化到 localStorage。
 */
export function updateEncodingDisplay(encoding) {
    const displayName = ENCODING_DISPLAY_NAMES[encoding] || encoding;
    DOM.encodingSelect.value = encoding;
    DOM.encodingStatus.textContent = displayName;
    EditorState.currentEncoding = encoding;
    saveToLocalStorage(STORAGE_KEYS.ENCODING, encoding);
}

/**
 * 仅更新状态栏显示（不修改下拉框与持久化）。
 *
 * 用于：
 *   · 导入文件时按 BOM / 扩展名检测到实际文件编码；
 *   · 下载文件时按扩展名推荐编码；
 *   这两种场景下用户选择的下拉框编码不变，只是当前文件的"实际编码"
 *   与"用户默认编码"不同。
 */
export function updateEncodingStatusOnly(encoding) {
    const displayName = ENCODING_DISPLAY_NAMES[encoding] || encoding;
    DOM.encodingStatus.textContent = displayName;
    EditorState.currentFileEncoding = encoding;
}

/**
 * 初始化编码设置（从 localStorage 恢复）。
 *
 * 若旧版本保存了已被移除的编码值（如 windows-1252 / gb18030 / utf-16le），
 * ENCODING_DISPLAY_NAMES[savedEncoding] 为 undefined，回退到 'auto'。
 */
export function initializeEncodingSettings() {
    const savedEncoding = loadFromLocalStorage(STORAGE_KEYS.ENCODING, 'auto');
    if (ENCODING_DISPLAY_NAMES[savedEncoding]) {
        updateEncodingDisplay(savedEncoding);
    } else {
        updateEncodingDisplay('auto');
    }
}

/**
 * 构造编码切换后的 Toast 文本。
 *
 * 分层策略：
 *   · 第一层：显示名（简短，与状态栏一致）；
 *   · 第二层：针对 'ansi' / 'gbk' 追加"实际行为"提示；
 *   · 第三层：动作影响范围。
 *
 * 之所以不在 Toast 中直接展示 ENCODING_LONG_DESCRIPTIONS 的完整文案，
 * 是因为 Toast 有 max-width: 80vw 限制，过长会截断。详细描述由
 * index.html 的 option title 承担（用户悬停即可看到）。
 */
function buildEncodingSwitchToastMessage(selectedEncoding, actionHint) {
    const displayName = ENCODING_DISPLAY_NAMES[selectedEncoding] || selectedEncoding;
    let message = '编码格式已切换为 ' + displayName;

    if (selectedEncoding === 'ansi') {
        const actualAnsi = resolveActualAnsiEncoding();
        message += '（当前环境实际使用 ' + (actualAnsi === 'gbk' ? 'GBK' : '纯 ASCII') + '）';
    } else if (selectedEncoding === 'gbk' && !isGBKSupported()) {
        message += '（当前浏览器不支持，使用时将提示）';
    }

    message += '，' + actionHint;
    return message;
}

/**
 * 绑定编码下拉框的 change 事件。
 *
 * 切换后：
 *   · 更新下拉框与状态栏；
 *   · 持久化到 localStorage；
 *   · 给出 Toast 提示，说明影响范围（导入自动检测 / 导出推荐 / 强制编码），
 *     并对 'ansi' / 'gbk' 追加实际行为提示。
 */
export function bindEncodingSelectEvents() {
    DOM.encodingSelect.addEventListener('change', function() {
        const selectedEncoding = this.value;
        updateEncodingDisplay(selectedEncoding);

        // 同步更新下拉框 option 的 title，展示详细描述。
        // 这样即便用户没有悬停，切换后也能通过 title 属性复核。
        const selectedOption = DOM.encodingSelect.options[DOM.encodingSelect.selectedIndex];
        if (selectedOption && ENCODING_LONG_DESCRIPTIONS[selectedEncoding]) {
            selectedOption.title = ENCODING_LONG_DESCRIPTIONS[selectedEncoding];
        }

        const actionHint = (selectedEncoding === 'auto')
            ? '导入时将自动检测编码，导出时按文件后缀推荐'
            : '将影响后续导入导出的编码格式';

        showToast(buildEncodingSwitchToastMessage(selectedEncoding, actionHint));
    });
}