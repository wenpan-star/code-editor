// filename: js/util.js
/**
 * ============================================================================
 * util.js — 通用工具函数
 * ============================================================================
 *
 * 【本次重构】
 *   1. 正则安全模式单一事实来源（P2）：
 *      原实现中危险模式列表在 util.js 与 search.js 的 Worker 脚本里
 *      各存一份，二者需要在两处同步维护。任何一处漏改都会让另一处
 *      的安全防线失效。
 *
 *      本次将 19 条危险模式提升为模块级导出常量
 *      DANGEROUS_REGEX_PATTERN_SOURCES，作为唯一权威来源：
 *        · util.js 内部用它构建 DANGEROUS_REGEX_PATTERNS 进行 isRegexSafe 检测；
 *        · search.js 的 Worker 脚本通过 DANGEROUS_REGEX_PATTERN_SOURCES
 *          动态内联生成 new RegExp(...) 调用，保证两处永远一致。
 *
 *   2. saveToLocalStorage 失败日志继续节流（5 秒最多一次），
 *      保留原有行为与节流常量。
 *
 *   3. 保留全部原有导出接口与行为：
 *      escapeHtml / escapeRegExp / isHighSurrogate / isLowSurrogate /
 *      sanitizeFilename / saveToLocalStorage / loadFromLocalStorage /
 *      isRegexSafe / buildSearchRegex。
 *
 * 无 DOM 依赖，无副作用。
 * ============================================================================
 */

// saveToLocalStorage 失败日志节流状态
let lastStorageErrorLogTime = 0;
const STORAGE_ERROR_LOG_THROTTLE_MS = 5000;

// ==================== 危险正则模式（单一事实来源） ====================

/**
 * 19 条危险正则模式源字符串。
 *
 * 这份列表是 ReDoS 防护的唯一权威来源：
 *   · util.js 内部用它构建 DANGEROUS_REGEX_PATTERNS 进行主线程检测；
 *   · search.js 的 Worker 脚本用同一份列表动态构建，避免两处漂移。
 *
 * 每条模式以字符串形式给出，由本模块在加载时编译为正则对象；
 * 也供 search.js 通过 JSON.stringify 内联到 Worker 脚本中。
 */
export const DANGEROUS_REGEX_PATTERN_SOURCES = Object.freeze([
    '\\([^)]*\\|[^)]*\\)[+*]{2,}',
    '\\((?:[^()]|\\\\([^()]*\\\\))*\\)[+*]{2,}',
    '\\(\\.\\*\\)[+*]',
    '\\(\\.\\+\\)[+*]',
    '\\w+\\+\\+',
    '\\w+\\*\\*',
    '\\([^)]*\\)\\{[^}]*,[^}]*\\}[+*]',
    '(\\[.*?\\])\\1[+*]',
    '([+*{]\\d*,?\\d*})[\\s\\S]*\\1',
    '\\([^)]*\\|[^)]*\\)[+*]',
    '\\([^)]*\\)[+*]\\s*[+*]',
    '\\([^)]+\\|[^)]+\\)\\+',
    '\\(\\w+\\s?\\?\\)[+*]',
    '\\([^)]*\\|[^)]*\\)\\+',
    '\\([^)]+\\|[^)]+\\)[+*]',
    '\\([a-zA-Z0-9_]+[+*?]\\)[+*]',
    '\\([^)]+\\|[^)]+\\)\\s*\\+',
    '\\([^)]+\\)\\+[+*]',
    '\\([^)]*[+*][^)]*\\)[+*]'
]);

// 由源字符串编译的正则对象数组（供 isRegexSafe 使用）。
const DANGEROUS_REGEX_PATTERNS = DANGEROUS_REGEX_PATTERN_SOURCES.map(function(source) {
    return new RegExp(source);
});

// ==================== 转义工具 ====================

export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeRegExp(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// ==================== 代理对判定 ====================

export function isHighSurrogate(charCode) {
    return charCode >= 0xD800 && charCode <= 0xDBFF;
}

export function isLowSurrogate(charCode) {
    return charCode >= 0xDC00 && charCode <= 0xDFFF;
}

// ==================== 文件名净化 ====================

export function sanitizeFilename(filename) {
    if (!filename) return 'code';
    return filename.trim().replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_') || 'code';
}

// ==================== localStorage ====================

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

// ==================== 正则安全检测 ====================

/**
 * 判断用户输入的正则是否安全。
 *
 * 使用模块级唯一权威列表 DANGEROUS_REGEX_PATTERNS：
 *   · 长度上限 100；
 *   · 遍历全部 19 条危险模式，命中即判为不安全；
 *   · 最后尝试 new RegExp 捕获语法错误。
 */
export function isRegexSafe(pattern) {
    if (!pattern || pattern.length > 100) return false;
    for (let i = 0; i < DANGEROUS_REGEX_PATTERNS.length; i++) {
        if (DANGEROUS_REGEX_PATTERNS[i].test(pattern)) return false;
    }
    try {
        new RegExp(pattern);
    } catch (e) {
        return false;
    }
    return true;
}

/**
 * 构建搜索正则。
 *
 * 非正则模式下，若开启 wholeWord 则包裹 \b；
 * 正则模式下先经过 isRegexSafe 检测再构建。
 */
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