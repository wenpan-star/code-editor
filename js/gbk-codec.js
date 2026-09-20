// filename: js/gbk-codec.js
/**
 * ============================================================================
 * gbk-codec.js — GBK 编解码（独立模块，针对 Chrome / Edge / Firefox）
 * ============================================================================
 *
 * 【本次更新】
 *   仅在文件首行补充 // filename: js/gbk-codec.js 标注，与项目约定统一。
 *   内容逻辑保持不变。
 *
 * 【目标浏览器】
 *   Chrome 38+ / Edge 79+ / Firefox 19+
 *   三大浏览器均原生支持 TextDecoder('gbk')，无需 polyfill。
 *
 * 【为什么独立成模块】
 *   GBK 与其他编码（UTF-8 / BOM / ASCII）有本质差异：
 *     · 其他编码的编码函数是纯函数（静态映射表）
 *     · GBK 需要"支持性探测 + 运行时构建映射表 + 后台预热"
 *   这套独立生命周期使得模块边界更清晰，未来扩展 GB18030 也有归宿。
 *
 * 【编码机制】
 *   浏览器没有 TextEncoder('gbk')，利用 TextDecoder('gbk') 反向构建：
 *     遍历所有合法 GBK 双字节序列（首字节 0x81-0xFE，次字节 0x40-0xFE
 *     排除 0x7F），逐一对每个序列以 fatal:true 解码；成功则登记为
 *     "字符 → 双字节码" 映射。
 *   构建约 24000 次 decode 调用，三大浏览器上耗时约 20-50ms。
 *
 * 【为什么不需要硬编码映射表】
 *   硬编码完整 GBK 表需 150KB+，而反向构建利用浏览器原生解码器，
 *   零源码体积增量，在目标浏览器上完全等价。
 *
 * 依赖：无（纯函数 + 浏览器原生 API）
 * ============================================================================
 */

// GBK 双字节范围常量
const GBK_HIGH_BYTE_MIN = 0x81;
const GBK_HIGH_BYTE_MAX = 0xFE;
const GBK_LOW_BYTE_MIN = 0x40;
const GBK_LOW_BYTE_MAX = 0xFE;
const GBK_LOW_BYTE_HOLE = 0x7F; // 次字节 0x7F 是空洞

// GBK 探测样本：多字符覆盖汉字 / 全角标点
const GBK_PROBE_SAMPLES = [
    { bytes: [0xC4, 0xE3], expected: '你' },        // 常用汉字
    { bytes: [0xD6, 0xD0], expected: '中' },        // 常用汉字
    { bytes: [0xA1, 0xA1], expected: '\u3000' },    // 全角空格
    { bytes: [0xA3, 0xA1], expected: '\uFF01' }     // 全角感叹号
];

// ==================== 模块级缓存 ====================

// 字符 → GBK 双字节码（高字节 << 8 | 低字节）
let gbkEncodeMapCache = null;

// 支持性探测结果缓存（true / false / null 表示未探测）
let gbkSupportCache = null;

// 探测失败原因（供 UI 层展示）
let gbkSupportError = null;

// ==================== 支持性探测 ====================

/**
 * 探测浏览器是否支持 GBK 解码。
 *
 * 三大目标浏览器均返回 true；本函数仅作防御性检查，
 * 保证在极少数非目标环境下能明确报错而非静默失败。
 *
 * 结果缓存，重复调用零成本。
 *
 * @returns {boolean}
 */
export function isGBKSupported() {
    if (gbkSupportCache !== null) {
        return gbkSupportCache;
    }

    if (typeof TextDecoder === 'undefined') {
        gbkSupportCache = false;
        gbkSupportError = 'TextDecoder 不可用';
        return false;
    }

    let decoder;
    try {
        // fatal:true 让无效序列抛错，比检查 U+FFFD 更可靠
        decoder = new TextDecoder('gbk', { fatal: true });
    } catch (constructError) {
        gbkSupportCache = false;
        gbkSupportError = 'TextDecoder 不支持 gbk 标签';
        return false;
    }

    // 多字符样本验证
    for (let index = 0; index < GBK_PROBE_SAMPLES.length; index++) {
        const sample = GBK_PROBE_SAMPLES[index];
        try {
            const decodedText = decoder.decode(new Uint8Array(sample.bytes));
            if (decodedText !== sample.expected) {
                gbkSupportCache = false;
                gbkSupportError = 'GBK 解码结果与预期不符';
                return false;
            }
        } catch (decodeError) {
            gbkSupportCache = false;
            gbkSupportError = 'GBK 样本解码抛错';
            return false;
        }
    }

    gbkSupportCache = true;
    gbkSupportError = null;
    return true;
}

/**
 * 获取 GBK 不支持的原因（用于 UI 层提示）。
 * 未探测或支持时返回 null。
 */
export function getGBKSupportError() {
    return gbkSupportError;
}

// ==================== 编码映射表构建 ====================

/**
 * 构建 GBK 编码映射表（字符 → 双字节码）。
 *
 * 映射表缓存，只构建一次。
 * 构建过程约 24000 次 decode 调用，耗时 20-50ms（三大浏览器）。
 *
 * @returns {Map<string, number> | null} 不支持 GBK 时返回 null
 */
function buildGBKEncodeMap() {
    if (gbkEncodeMapCache) {
        return gbkEncodeMapCache;
    }
    if (!isGBKSupported()) {
        return null;
    }

    const decoder = new TextDecoder('gbk', { fatal: true });
    const encodeMap = new Map();
    const byteBuffer = new Uint8Array(2);

    for (let highByte = GBK_HIGH_BYTE_MIN; highByte <= GBK_HIGH_BYTE_MAX; highByte++) {
        byteBuffer[0] = highByte;
        for (let lowByte = GBK_LOW_BYTE_MIN; lowByte <= GBK_LOW_BYTE_MAX; lowByte++) {
            if (lowByte === GBK_LOW_BYTE_HOLE) {
                continue;
            }
            byteBuffer[1] = lowByte;
            try {
                const decodedCharacter = decoder.decode(byteBuffer);
                // fatal:true 下成功解码必为单字符；
                // 保留 !has 判断以防万一（GBK 理论上是双射的）
                if (decodedCharacter.length === 1 && !encodeMap.has(decodedCharacter)) {
                    encodeMap.set(decodedCharacter, (highByte << 8) | lowByte);
                }
            } catch (decodeError) {
                // 无效序列，跳过
            }
        }
    }

    gbkEncodeMapCache = encodeMap;
    return encodeMap;
}

// ==================== 后台预热 ====================

/**
 * 后台预热 GBK 映射表。
 *
 * 在浏览器空闲时构建，用户在真正需要（下载 .bat）时无感知延迟。
 * 应在应用初始化完成后调用一次。
 */
export function warmupGBKCodec() {
    if (!isGBKSupported()) {
        return;
    }
    const buildTask = function() {
        buildGBKEncodeMap();
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(buildTask, { timeout: 3000 });
    } else {
        // 极少数环境不支持 requestIdleCallback：延迟执行避免阻塞首屏
        setTimeout(buildTask, 1500);
    }
}

// ==================== 编码 / 解码 ====================

/**
 * 将文本编码为 GBK 字节数组。
 *
 * 无法映射的字符（BMP 外字符、GBK 范围外符号）替换为 '?'（0x3F）。
 *
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {Error} 浏览器不支持 GBK 时抛出，调用方应捕获并提示用户
 */
export function encodeTextToGBK(text) {
    const encodeMap = buildGBKEncodeMap();
    if (!encodeMap) {
        throw new Error(
            'GBK 编码不可用：' + (gbkSupportError || '当前浏览器不支持')
        );
    }

    const byteArray = [];
    for (let index = 0; index < text.length; index++) {
        const charCode = text.charCodeAt(index);

        // ASCII 直通
        if (charCode <= 0x7F) {
            byteArray.push(charCode);
            continue;
        }

        // 代理对（BMP 外字符）：GBK 无法表示
        if (charCode >= 0xD800 && charCode <= 0xDBFF && index + 1 < text.length) {
            const nextCharCode = text.charCodeAt(index + 1);
            if (nextCharCode >= 0xDC00 && nextCharCode <= 0xDFFF) {
                byteArray.push(0x3F);
                index++;
                continue;
            }
        }

        const gbkCode = encodeMap.get(text[index]);
        if (gbkCode !== undefined) {
            byteArray.push((gbkCode >> 8) & 0xFF);
            byteArray.push(gbkCode & 0xFF);
        } else {
            byteArray.push(0x3F);
        }
    }

    return new Uint8Array(byteArray);
}

/**
 * 从 ArrayBuffer 解码为 GBK 文本。
 *
 * 使用 fatal:false（默认），无效序列以替换字符呈现，适合容错读取。
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
 * @throws {Error} 浏览器不支持 GBK 时抛出
 */
export function decodeTextFromGBK(arrayBuffer) {
    if (!isGBKSupported()) {
        throw new Error(
            'GBK 解码不可用：' + (gbkSupportError || '当前浏览器不支持')
        );
    }
    const decoder = new TextDecoder('gbk');
    return decoder.decode(arrayBuffer);
}