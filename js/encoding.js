// filename: js/encoding.js
/**
 * ============================================================================
 * encoding.js — 编码统一入口 + UTF-8 / BOM / ANSI / GBK / ASCII
 * ============================================================================
 *
 * 本模块职责：
 *   1. 支持 6 种编码：
 *       · utf-8       —— TextEncoder / TextDecoder 原生
 *       · utf-8-bom   —— UTF-8 + 3 字节 BOM
 *       · ansi        —— 系统默认 ANSI（简中 Windows = GBK，GBK 不可用回退 ASCII）
 *       · gbk         —— 明确 GBK（不支持时硬报错）
 *       · ascii       —— 纯 ASCII（非 ASCII 字符替换为 '?'）
 *   2. UTF-8 字节流有效性检测（isValidUTF8）
 *   3. 纯 ASCII 编码（含代理对处理）
 *   4. 统一编码入口（encodeTextToBytes / decodeTextFromBytes）
 *   5. UI 集成（编码显示 / 下拉框事件绑定）
 *
 * 【本次更新】
 *   1. encodeTextToBytes 与 decodeTextFromBytes 的 default 分支
 *      增加 console.warn —— 遇到未知编码值（如旧版遗留的 windows-1252）
 *      时明确记录降级行为，避免用户以为保存/读取的是非 UTF-8 编码。
 *
 *   2. UI 美化一致性：
 *      updateEncodingDisplay 与 updateEncodingStatusOnly 移除状态栏
 *      Emoji 前缀 '📄 '。原实现在状态栏显示 "📄 自动检测"，与本次
 *      UI 美化"状态栏全文字 + 状态点"的目标不一致（高亮指示器已改为
 *      6px 圆点 + 纯文字，自动保存指示器已改为纯文字）。本模块的
 *      Emoji 是最后残留的一处，现统一去除。
 *
 *      状态栏最终形态：纯文字编码名（如"自动检测"），与其他信息块
 *      （"行 0 · 字符 0"、"JavaScript"、"缩进 4 空格"）风格统一。
 *
 * 依赖：
 *   - state.js / config.js / util.js / dom.js / toast.js
 *   - gbk-codec.js（GBK 编解码委托）
 * ============================================================================
 */

import { EditorState } from './state.js';
import { STORAGE_KEYS, ENCODING_DISPLAY_NAMES } from './config.js';
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
 *
 * 适用场景：老式 .bat / .cmd 脚本，某些老式 Windows 环境无法正确处理
 * 非 ASCII 字节，用纯 ASCII 保证兼容性。
 *
 * @param {string} text
 * @returns {Uint8Array}
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
 *
 * 注意：本函数不做静默检查 —— 调用方（file-io.js）应根据
 * resolveActualAnsiEncoding() 的返回值在 UI 层提示用户"已回退到 ASCII"。
 *
 * @param {string} text
 * @returns {Uint8Array}
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
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
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
 * 供调用方在 UI 层展示"实际编码"提示。
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
            // 输出 console.warn 让开发者 / 高级用户在控制台能看到降级事实，
            // 避免"以为是 GBK 实际是 UTF-8"这类静默不匹配。
            console.warn('未知编码值:', encoding, '，编码时已降级为 UTF-8');
            return new TextEncoder().encode(text);
    }
}

/**
 * 从字节数组解码为文本。
 *
 * 支持：utf-8 / utf-8-bom / ansi / gbk / ascii。
 * ANSI 与 GBK 均委托 gbk-codec.js（ANSI 内部有软回退）；
 * ASCII 用 UTF-8 解码器处理（ASCII 是 UTF-8 子集）。
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
    // 若文件中出现非 ASCII 字节（不应发生），UTF-8 解码器以替换字符处理。
    const decoderEncodingMap = {
        'utf-8': 'utf-8',
        'utf-8-bom': 'utf-8',
        'ascii': 'utf-8'
    };
    let decoderEncoding = decoderEncodingMap[encoding];
    if (!decoderEncoding) {
        // 未知 / 历史遗留编码值（含被移除的 windows-1252）→ 回退 utf-8。
        // 输出 console.warn 明确降级事实，避免静默错误。
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
 * 与状态栏其他信息块（"行 0 · 字符 0"、"JavaScript"、"缩进 4 空格"）
 * 风格统一。
 *
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
 * 绑定编码下拉框的 change 事件。
 *
 * 切换后：
 *   · 更新下拉框与状态栏；
 *   · 持久化到 localStorage；
 *   · 给出 Toast 提示，说明影响范围（导入自动检测 / 导出推荐 / 强制编码）。
 */
export function bindEncodingSelectEvents() {
    DOM.encodingSelect.addEventListener('change', function() {
        const selectedEncoding = this.value;
        updateEncodingDisplay(selectedEncoding);
        const actionHint = (selectedEncoding === 'auto')
            ? '导入时将自动检测编码，导出时按文件后缀推荐'
            : '将影响后续导入导出的编码格式';
        showToast('编码格式已切换为 ' + ENCODING_DISPLAY_NAMES[selectedEncoding] + '，' + actionHint);
    });
}