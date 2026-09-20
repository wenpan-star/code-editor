// filename: js/util.js
/**
 * ============================================================================
 * util.js — 通用工具函数
 * ============================================================================
 *
 * 【本次更新】
 *   仅在文件首行补充 // filename: js/util.js 标注，与项目约定统一。
 *   内容逻辑保持不变。
 *
 * 工具函数清单：
 *   - escapeHtml / escapeRegExp —— 转义工具
 *   - isHighSurrogate / isLowSurrogate —— 代理对判定
 *   - sanitizeFilename —— 文件名净化
 *   - saveToLocalStorage / loadFromLocalStorage —— localStorage 读写
 *     （saveToLocalStorage 失败时输出节流日志，5 秒最多一次）
 *   - isRegexSafe —— 正则安全检测（含 19 条危险模式）
 *   - buildSearchRegex —— 构建搜索正则
 *
 * 无 DOM 依赖，无副作用。
 * ============================================================================
 */

// saveToLocalStorage 失败日志节流状态
let lastStorageErrorLogTime = 0;
const STORAGE_ERROR_LOG_THROTTLE_MS = 5000;

export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeRegExp(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function isHighSurrogate(charCode) {
    return charCode >= 0xD800 && charCode <= 0xDBFF;
}

export function isLowSurrogate(charCode) {
    return charCode >= 0xDC00 && charCode <= 0xDFFF;
}

export function sanitizeFilename(filename) {
    if (!filename) return 'code';
    return filename.trim().replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_') || 'code';
}

/**
 * 写入 localStorage。
 *
 * 失败时记录节流日志（5 秒最多一次），避免完全静默导致的数据丢失隐患。
 */
export function saveToLocalStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (storageError) {
        const currentTime = Date.now();
        if (currentTime - lastStorageErrorLogTime > STORAGE_ERROR_LOG_THROTTLE_MS) {
            console.warn('localStorage 写入失败（可能导致设置或自动保存丢失）:', key, storageError);
            lastStorageErrorLogTime = currentTime;
        }
    }
}

export function loadFromLocalStorage(key, defaultValue) {
    try {
        const storedItem = localStorage.getItem(key);
        if (storedItem !== null) return JSON.parse(storedItem);
        return defaultValue;
    } catch (parseError) {
        return defaultValue;
    }
}

export function isRegexSafe(pattern) {
    if (!pattern || pattern.length > 100) return false;
    const dangerousPatterns = [
        /\([^)]*\|[^)]*\)[+*]{2,}/,
        /\((?:[^()]|\([^()]*\))*\)[+*]{2,}/,
        /\(\.\*\)[+*]/,
        /\(\.\+\)[+*]/,
        /\w+\+\+/,
        /\w+\*\*/,
        /\([^)]*\)\{[^}]*,[^}]*\}[+*]/,
        /(\[.*?\])\1[+*]/,
        /([+*{]\d*,?\d*})[\s\S]*\1/,
        /\([^)]*\|[^)]*\)[+*]/,
        /\([^)]*\)[+*]\s*[+*]/,
        /\([^)]+\|[^)]+\)\+/,
        /\(\w+\s?\?\)[+*]/,
        /\([^)]*\|[^)]*\)\+/,
        /\([^)]+\|[^)]+\)[+*]/,
        /\([a-zA-Z0-9_]+[+*?]\)[+*]/,
        /\([^)]+\|[^)]+\)\s*\+/,
        /\([^)]+\)\+[+*]/,
        /\([^)]*[+*][^)]*\)[+*]/
    ];
    for (let i = 0; i < dangerousPatterns.length; i++) {
        if (dangerousPatterns[i].test(pattern)) return false;
    }
    try {
        new RegExp(pattern);
    } catch (e) {
        return false;
    }
    return true;
}

export function buildSearchRegex(searchTerm, caseSensitive, wholeWord, useRegex) {
    if (!searchTerm) return null;
    let pattern;
    if (useRegex) {
        if (!isRegexSafe(searchTerm)) return null;
        try {
            new RegExp(searchTerm);
            pattern = searchTerm;
        } catch (e) {
            return null;
        }
    } else {
        const escapedTerm = escapeRegExp(searchTerm);
        pattern = wholeWord ? '\\b' + escapedTerm + '\\b' : escapedTerm;
    }
    const flags = 'g' + (caseSensitive ? '' : 'i');
    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        return null;
    }
}