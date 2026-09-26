// filename: js/file-io.js
/**
 * ============================================================================
 * file-io.js — 文件导入 / 下载 / 拖拽 / 后缀约束 / TXT 历史
 * ============================================================================
 *
 * 【本次重构（P2 修复：历史记录时机完整化）】
 *
 *   问题：
 *     原实现中后缀历史的记录点只有 commitFileExtensionValue 内部，
 *     由 change 事件与 Enter 键触发。这导致以下两条路径漏记历史：
 *       · 输入后未失焦直接点击"下载"按钮 → 焦点转移到按钮 →
 *         输入框的 change 事件未必触发 → 历史未记录；
 *       · 输入后未失焦直接点击语言下拉切换 → 焦点转移 →
 *         change 事件未必触发 → 历史未记录。
 *     用户会困惑："我明明输入过 log，为什么下拉里没有？"
 *
 *   修复：
 *     引入模块级标记 fileExtensionValueCommitted：
 *       · 初始值 true（值已同步，视为已提交）；
 *       · focus 事件 → 置为 true（刚聚焦，值未变更）；
 *       · input 事件 → 置为 false（值已变更，未提交）；
 *       · commitFileExtensionValue 执行 → 置为 true（已提交）；
 *       · handleExtensionItemSelect 执行 → 置为 true（点击已提交）；
 *       · blur 事件 → 若 committed === false，则调用
 *         commitFileExtensionValue 完成一次隐式提交。
 *
 *   为什么 blur 时要检查 committed 而不是无条件 commit？
 *     · Enter 提交后紧接着 this.blur()，若无条件 commit 会重复；
 *     · 点击下拉项后 focus 回到输入框，若无条件 commit 会误触发；
 *     · 只有 committed === false 时才是"用户输入后未提交即失焦"，
 *       此时才需要补一次提交。
 *
 *   修复后行为：
 *     · TXT 输入 log（未失焦）→ 点下载 → blur 触发 → 提交 → 历史含 log ✓
 *     · TXT 输入 conf（未失焦）→ 点语言下拉 → blur 触发 → 提交 → 历史含 conf ✓
 *     · TXT 输入 log（未失焦）→ Enter → commit → blur → committed 已 true → 不重复 ✓
 *     · TXT 输入 log → 点击下拉中已存在的项 → handleExtensionItemSelect
 *       已置 committed = true → 随后 blur 不重复 ✓
 *
 *   本次修复不改变任何导出接口签名，不改变 DOM 结构，不改变存储键，
 *   仅补强已有逻辑。
 *
 * 【保留的既有设计（不修改）】
 *   · 后缀合法集合由 config.js 的 LANGUAGE_VALID_EXTENSIONS 唯一声明；
 *   · 记忆由 EditorState.languageExtensionMap 唯一承担；
 *   · TXT 后缀历史由 EditorState.txtExtensionHistory 唯一承担；
 *   · 导入文件时不更新记忆；
 *   · 启动时一次性清理 FILE_EXTENSION_HISTORY 与 v8.4.1 单一后缀键；
 *   · readOnly 由"集合是否为空"决定；
 *   · 受约束模式只显示合法集合，自由模式只显示历史。
 * ============================================================================
 */

import { EditorState } from './state.js';
import {
    CONFIG,
    STORAGE_KEYS,
    ENCODING_DISPLAY_NAMES,
    EXTENSION_DEFAULT_ENCODING,
    LANGUAGE_EXTENSIONS,
    AUTO_EXTENSION_BY_LANGUAGE,
    LANGUAGE_VALID_EXTENSIONS,
    MIME_TYPES,
    EXTENSION_LANGUAGE_MAP,
    VALID_TEXT_FILE_EXTENSION_REGEX
} from './config.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { saveToLocalStorage, loadFromLocalStorage, sanitizeFilename } from './util.js';
import { setEditorContent, switchLanguage, updateFileNameDisplay } from './editor-api.js';
import {
    detectBOMEncoding,
    isValidUTF8,
    decodeTextFromBytes,
    encodeTextToBytes,
    updateEncodingDisplay,
    updateEncodingStatusOnly,
    resolveActualAnsiEncoding
} from './encoding.js';
import { isGBKSupported, getGBKSupportError } from './gbk-codec.js';
import { getOrCreateSaveDirectory } from './directory-io.js';
import {
    writeFileToDirectory,
    clearDirectoryHandle
} from './storage.js';

// ==================== 模块级状态 ====================

// 输入净化标志：程序化修改 value 期间置位，防止二次 input 事件重复处理。
let isSanitizingFileExtension = false;

// 幂等保护标志：防止 initializeFileExtensionInput 被重复调用。
let isFileExtensionInputInitialized = false;

// 输入框聚焦时的"记忆快照"。
// 用途：change 事件校验失败时回滚到该快照。
let fileExtensionFocusSnapshot = '';

// 输入框当前值是否已通过 change / Enter / blur 正式提交。
//
// 语义：
//   · true  → 值已提交（写 map + 写历史 + Toast 提示已完成）；
//   · false → 值已变更但尚未提交（input 事件乐观写入 map 后置为 false）。
//
// 生命周期：
//   · 模块加载 → true（无变更）；
//   · focus 事件 → true（刚聚焦，值未变更）；
//   · input 事件 → false（值已变更）；
//   · commitFileExtensionValue 执行 → true；
//   · handleExtensionItemSelect 执行 → true；
//   · blur 事件检查此标记，若 false 则补一次 commit。
let fileExtensionValueCommitted = true;

/**
 * 所有语言合法后缀的并集（预计算 Set）。
 */
const ALL_RESERVED_EXTENSIONS = (function buildReservedExtensionsSet() {
    const reservedSet = new Set();
    const languageKeys = Object.keys(LANGUAGE_VALID_EXTENSIONS);
    for (let languageIndex = 0; languageIndex < languageKeys.length; languageIndex++) {
        const languageKey = languageKeys[languageIndex];
        const validList = LANGUAGE_VALID_EXTENSIONS[languageKey];
        for (let extensionIndex = 0; extensionIndex < validList.length; extensionIndex++) {
            reservedSet.add(validList[extensionIndex]);
        }
    }
    return reservedSet;
})();

// ==================== 导入 ====================

/**
 * 加载文件到编辑器。
 *
 * 编码决策顺序：
 *   1. BOM 检测；
 *   2. 当前编码为 'auto' 时按扩展名推荐；
 *   3. 按 UTF-8 有效性检测。
 *
 * 后缀记忆行为：
 *   · 导入文件**不更新** languageExtensionMap；
 *   · 导入的语言选择是"高亮选择"，不是"后缀选择"。
 */
function loadFileIntoEditor(file) {
    if (!file) return;

    const isValidTextFile = (file.type && file.type.startsWith('text/'))
        || VALID_TEXT_FILE_EXTENSION_REGEX.test(file.name);
    if (!isValidTextFile) {
        showToast('⚠️ 仅支持文本文件', true);
        return;
    }
    if (file.size > EditorState.absoluteFileSizeLimit) {
        showToast('❌ 文件超过 2MB，已阻止加载以避免卡顿', true);
        return;
    }

    const fileReader = new FileReader();
    fileReader.onload = function(loadEvent) {
        const arrayBuffer = loadEvent.target.result;
        const detectedBomEncoding = detectBOMEncoding(arrayBuffer);
        const userExplicitEncoding = EditorState.currentEncoding;
        let finalEncoding = userExplicitEncoding;

        if (detectedBomEncoding) {
            finalEncoding = detectedBomEncoding;
            if (userExplicitEncoding === 'auto') {
                updateEncodingDisplay(finalEncoding);
            } else {
                updateEncodingStatusOnly(finalEncoding);
            }
            showToast('📂 检测到编码: ' + ENCODING_DISPLAY_NAMES[finalEncoding]);
        } else if (finalEncoding === 'auto') {
            const fileExtension = file.name.split('.').pop().toLowerCase();
            const recommendedEncoding = EXTENSION_DEFAULT_ENCODING[fileExtension];

            if (recommendedEncoding === 'ansi') {
                finalEncoding = 'ansi';
                updateEncodingStatusOnly(finalEncoding);
                if (isGBKSupported()) {
                    showToast('📂 已根据 .' + fileExtension + ' 后缀使用 ANSI（简体中文系统即 GBK）');
                } else {
                    showToast('ℹ️ ANSI 回退为 ASCII（当前浏览器不支持 GBK）');
                }
            } else if (recommendedEncoding === 'gbk') {
                if (isGBKSupported()) {
                    finalEncoding = 'gbk';
                    updateEncodingStatusOnly(finalEncoding);
                    showToast('📂 已根据 .' + fileExtension + ' 后缀使用 GBK 编码');
                } else {
                    finalEncoding = 'utf-8';
                    updateEncodingStatusOnly(finalEncoding);
                    showToast('⚠️ 当前浏览器不支持 GBK 解码，已按 UTF-8 处理', true);
                }
            } else if (isValidUTF8(arrayBuffer)) {
                finalEncoding = 'utf-8';
                updateEncodingStatusOnly(finalEncoding);
                showToast('📂 未检测到 BOM，默认使用 UTF-8');
            } else {
                finalEncoding = 'utf-8';
                updateEncodingStatusOnly(finalEncoding);
                showToast(
                    '⚠️ 字节流不是有效的 UTF-8，可能是其他编码（如 GBK），请手动选择',
                    true
                );
            }
        } else {
            if (finalEncoding === 'gbk' && !isGBKSupported()) {
                showToast('⚠️ 当前浏览器不支持 GBK 解码，将按 UTF-8 处理', true);
                finalEncoding = 'utf-8';
            }
            if (finalEncoding === 'ansi' && !isGBKSupported()) {
                showToast('ℹ️ ANSI 回退为 ASCII（当前浏览器不支持 GBK）');
            }
            updateEncodingStatusOnly(finalEncoding);
        }

        let decodedText;
        try {
            decodedText = decodeTextFromBytes(arrayBuffer, finalEncoding);
        } catch (decodeError) {
            console.error('解码失败:', decodeError);
            showToast('❌ 解码失败：' + (decodeError.message || '未知错误'), true);
            return;
        }

        setEditorContent(decodedText, true, false, 0, 0);
        updateFileNameDisplay(file.name);

        const fileExtension = file.name.split('.').pop().toLowerCase();
        if (EXTENSION_LANGUAGE_MAP[fileExtension]) {
            switchLanguage(EXTENSION_LANGUAGE_MAP[fileExtension]);
        }
        showToast('📂 已加载 ' + file.name + ' (' + ENCODING_DISPLAY_NAMES[finalEncoding] + ')');
    };
    fileReader.onerror = function() {
        showToast('❌ 文件读取失败', true);
    };
    fileReader.readAsArrayBuffer(file);
}

// ==================== 导入事件绑定 ====================

export function bindImportEvents() {
    DOM.btnImport.addEventListener('click', function() {
        DOM.fileInput.click();
    });

    DOM.fileInput.addEventListener('change', function(event) {
        const selectedFile = event.target.files[0];
        if (!selectedFile) return;
        loadFileIntoEditor(selectedFile);
        DOM.fileInput.value = '';
    });
}

// ==================== 拖拽事件绑定 ====================

export function bindDragAndDropEvents() {
    DOM.editorWrapper.addEventListener('dragover', function(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });

    DOM.editorWrapper.addEventListener('drop', function(event) {
        event.preventDefault();
        const droppedFile = event.dataTransfer.files[0];
        if (!droppedFile) return;
        loadFileIntoEditor(droppedFile);
    });
}

// ==================== 后缀：净化与读取 ====================

/**
 * 净化后缀字符串。
 */
export function sanitizeFileExtension(extensionText) {
    if (extensionText === null || extensionText === undefined) return '';
    return String(extensionText)
        .trim()
        .replace(/^\.+/, '')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .toLowerCase()
        .slice(0, CONFIG.FILE_EXTENSION_MAX_LENGTH);
}

/**
 * 从输入框读取当前后缀（已净化，未校验）。
 */
export function getCustomFileExtension() {
    if (!DOM.fileExtensionInput) return '';
    return sanitizeFileExtension(DOM.fileExtensionInput.value);
}

// ==================== 后缀：合法性与占用校验 ====================

/**
 * 判断后缀是否被其他语言占用。
 */
function isExtensionUsedByOtherLanguage(language, extension) {
    if (!extension) return false;
    if (!ALL_RESERVED_EXTENSIONS.has(extension)) return false;
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    if (Array.isArray(validList) && validList.indexOf(extension) !== -1) {
        return false;
    }
    return true;
}

/**
 * 综合判定：后缀是否可以在该语言下使用。
 *
 * 两种模式：
 *   1. 受约束模式（集合非空）：空值非法；非空值必须属于集合；
 *   2. 自由模式（集合为空，TXT）：空值合法；非空值必须不被其他语言占用。
 */
function isExtensionAllowedForLanguage(language, extension) {
    const validList = LANGUAGE_VALID_EXTENSIONS[language];

    if (Array.isArray(validList) && validList.length > 0) {
        if (!extension) return false;
        return validList.indexOf(extension) !== -1;
    }

    if (!extension) return true;
    return !isExtensionUsedByOtherLanguage(language, extension);
}

/**
 * 从记忆恢复语言的有效后缀。
 */
function resolveExtensionForLanguage(language) {
    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }
    const memoryValue = EditorState.languageExtensionMap[language];
    if (isExtensionAllowedForLanguage(language, memoryValue)) {
        return memoryValue;
    }
    return AUTO_EXTENSION_BY_LANGUAGE[language] || '';
}

// ==================== TXT 后缀历史 ====================

/**
 * 从 localStorage 加载 TXT 后缀历史到 EditorState.txtExtensionHistory。
 *
 * 清洗策略（防御式）：
 *   · 若存储值不是数组 → 视为空；
 *   · 逐项净化：非法字符过滤、小写、长度截断；
 *   · 跳过空值；
 *   · 跳过被其他语言占用的后缀（保证历史无污染）；
 *   · 去重（保留首次出现的顺序）；
 *   · 截断到 CONFIG.FILE_EXTENSION_HISTORY_MAX。
 */
function loadTxtExtensionHistory() {
    const rawHistory = loadFromLocalStorage(STORAGE_KEYS.TXT_EXTENSION_HISTORY, []);
    if (!Array.isArray(rawHistory)) {
        EditorState.txtExtensionHistory = [];
        return EditorState.txtExtensionHistory;
    }

    const sanitizedList = [];
    const seenSet = new Set();
    for (let index = 0; index < rawHistory.length; index++) {
        const sanitized = sanitizeFileExtension(rawHistory[index]);
        if (!sanitized) continue;
        if (seenSet.has(sanitized)) continue;
        if (isExtensionUsedByOtherLanguage('txt', sanitized)) continue;
        seenSet.add(sanitized);
        sanitizedList.push(sanitized);
        if (sanitizedList.length >= CONFIG.FILE_EXTENSION_HISTORY_MAX) break;
    }

    EditorState.txtExtensionHistory = sanitizedList;
    return sanitizedList;
}

/**
 * 将 EditorState.txtExtensionHistory 持久化到 localStorage。
 */
function saveTxtExtensionHistory() {
    if (!Array.isArray(EditorState.txtExtensionHistory)) {
        EditorState.txtExtensionHistory = [];
    }
    saveToLocalStorage(STORAGE_KEYS.TXT_EXTENSION_HISTORY, EditorState.txtExtensionHistory);
}

/**
 * 添加一项到 TXT 后缀历史（MRU 顺序）。
 */
function addTxtExtensionHistoryItem(extensionText) {
    const sanitized = sanitizeFileExtension(extensionText);
    if (!sanitized) return;
    if (isExtensionUsedByOtherLanguage('txt', sanitized)) return;

    if (!Array.isArray(EditorState.txtExtensionHistory)) {
        EditorState.txtExtensionHistory = [];
    }

    const existingIndex = EditorState.txtExtensionHistory.indexOf(sanitized);
    if (existingIndex !== -1) {
        EditorState.txtExtensionHistory.splice(existingIndex, 1);
    }

    EditorState.txtExtensionHistory.unshift(sanitized);

    if (EditorState.txtExtensionHistory.length > CONFIG.FILE_EXTENSION_HISTORY_MAX) {
        EditorState.txtExtensionHistory.length = CONFIG.FILE_EXTENSION_HISTORY_MAX;
    }

    saveTxtExtensionHistory();
}

/**
 * 从 TXT 后缀历史中移除一项。
 */
function removeTxtExtensionHistoryItem(extensionText) {
    const sanitized = sanitizeFileExtension(extensionText);
    if (!sanitized) return;
    if (!Array.isArray(EditorState.txtExtensionHistory)) return;

    const existingIndex = EditorState.txtExtensionHistory.indexOf(sanitized);
    if (existingIndex === -1) return;

    EditorState.txtExtensionHistory.splice(existingIndex, 1);
    saveTxtExtensionHistory();
}

// ==================== 后缀：语言切换联动 ====================

/**
 * 语言切换时更新后缀框。
 */
export function updateFileExtensionForLanguage(language) {
    if (!DOM.fileExtensionInput) return;

    // ---- 1. 主动失焦 ----
    if (document.activeElement === DOM.fileExtensionInput) {
        DOM.fileExtensionInput.blur();
    }

    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }

    // ---- 2. 恢复有效值 ----
    const resolvedValue = resolveExtensionForLanguage(language);
    EditorState.languageExtensionMap[language] = resolvedValue;

    DOM.fileExtensionInput.value = resolvedValue;

    // ---- 3. 设置 readOnly ----
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    const hasFixedCollection = Array.isArray(validList) && validList.length > 0;
    DOM.fileExtensionInput.readOnly = hasFixedCollection;

    // ---- 4. 更新提示 ----
    updateFileExtensionPlaceholder();

    // ---- 5. 隐藏下拉 ----
    hideFileExtensionDropdown();

    // ---- 6. 持久化 ----
    saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

    // ---- 7. 值视为已提交（切换语言后不会触发 blur 补提交） ----
    fileExtensionValueCommitted = true;
}

// ==================== 后缀：受约束模式下拉渲染 ====================

/**
 * 渲染受约束语言的合法集合下拉。
 */
function renderFileExtensionDropdown() {
    if (!DOM.fileExtensionDropdown) return;

    const currentLanguage = EditorState.currentLanguage;
    const validList = LANGUAGE_VALID_EXTENSIONS[currentLanguage];

    if (!Array.isArray(validList) || validList.length === 0) {
        DOM.fileExtensionDropdown.style.display = 'none';
        if (DOM.fileExtensionInput) {
            DOM.fileExtensionInput.setAttribute('aria-expanded', 'false');
        }
        return;
    }

    const dropdownElement = DOM.fileExtensionDropdown;
    dropdownElement.innerHTML = '';

    const currentValue = EditorState.languageExtensionMap[currentLanguage] || '';

    for (let index = 0; index < validList.length; index++) {
        const extensionValue = validList[index];

        const itemElement = document.createElement('div');
        itemElement.className = 'file-extension-dropdown-item';
        itemElement.setAttribute('role', 'option');
        itemElement.setAttribute('data-value', extensionValue);

        const textElement = document.createElement('span');
        textElement.className = 'file-extension-dropdown-item-text';
        textElement.textContent = extensionValue;
        itemElement.appendChild(textElement);

        itemElement.addEventListener('mousedown', function(event) {
            event.preventDefault();
            event.stopPropagation();
            handleExtensionItemSelect(extensionValue);
        });

        if (extensionValue === currentValue) {
            itemElement.classList.add('active');
            itemElement.setAttribute('aria-selected', 'true');
        } else {
            itemElement.setAttribute('aria-selected', 'false');
        }

        dropdownElement.appendChild(itemElement);
    }

    dropdownElement.style.display = 'block';
    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.setAttribute('aria-expanded', 'true');
    }
}

// ==================== 后缀：TXT 历史下拉渲染 ====================

/**
 * 渲染 TXT 历史下拉。
 */
function renderTxtHistoryDropdown() {
    if (!DOM.fileExtensionDropdown) return;

    if (!Array.isArray(EditorState.txtExtensionHistory)
        || EditorState.txtExtensionHistory.length === 0) {
        DOM.fileExtensionDropdown.style.display = 'none';
        if (DOM.fileExtensionInput) {
            DOM.fileExtensionInput.setAttribute('aria-expanded', 'false');
        }
        return;
    }

    const dropdownElement = DOM.fileExtensionDropdown;
    dropdownElement.innerHTML = '';

    const currentValue = EditorState.languageExtensionMap.txt || '';

    for (let index = 0; index < EditorState.txtExtensionHistory.length; index++) {
        const extensionValue = EditorState.txtExtensionHistory[index];

        const itemElement = document.createElement('div');
        itemElement.className = 'file-extension-dropdown-item';
        itemElement.setAttribute('role', 'option');
        itemElement.setAttribute('data-value', extensionValue);

        const textElement = document.createElement('span');
        textElement.className = 'file-extension-dropdown-item-text';
        textElement.textContent = extensionValue;
        itemElement.appendChild(textElement);

        const deleteButtonElement = document.createElement('span');
        deleteButtonElement.className = 'file-extension-dropdown-item-delete';
        deleteButtonElement.textContent = '×';
        deleteButtonElement.title = '删除该历史后缀';
        deleteButtonElement.addEventListener('mousedown', function(event) {
            event.preventDefault();
            event.stopPropagation();
            removeTxtExtensionHistoryItem(extensionValue);
            renderTxtHistoryDropdown();
        });
        itemElement.appendChild(deleteButtonElement);

        itemElement.addEventListener('mousedown', function(event) {
            if (event.target === deleteButtonElement) return;
            event.preventDefault();
            event.stopPropagation();
            handleExtensionItemSelect(extensionValue);
        });

        if (extensionValue === currentValue) {
            itemElement.classList.add('active');
            itemElement.setAttribute('aria-selected', 'true');
        } else {
            itemElement.setAttribute('aria-selected', 'false');
        }

        dropdownElement.appendChild(itemElement);
    }

    dropdownElement.style.display = 'block';
    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.setAttribute('aria-expanded', 'true');
    }
}

// ==================== 后缀：下拉项被选中 ====================

/**
 * 下拉项被选中后的处理。
 *
 * 值已提交（点击即视为一次明确选择），
 * 因此将 fileExtensionValueCommitted 置为 true，
 * 后续 blur 不会重复提交。
 */
function handleExtensionItemSelect(selectedValue) {
    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }
    EditorState.languageExtensionMap[EditorState.currentLanguage] = selectedValue;

    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.value = selectedValue;
        DOM.fileExtensionInput.focus();
    }

    saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
    updateFileExtensionPlaceholder();
    hideFileExtensionDropdown();

    // 标记为已提交：避免随后的 blur 触发补提交
    fileExtensionValueCommitted = true;
}

// ==================== 后缀：显示 / 隐藏下拉 ====================

/**
 * 显示后缀下拉列表（按模式分发）。
 */
export function showFileExtensionDropdown() {
    if (!DOM.fileExtensionInput) return;
    const currentLanguage = EditorState.currentLanguage;
    const validList = LANGUAGE_VALID_EXTENSIONS[currentLanguage];

    if (Array.isArray(validList) && validList.length > 0) {
        renderFileExtensionDropdown();
    } else {
        renderTxtHistoryDropdown();
    }
}

/**
 * 隐藏后缀下拉列表。
 */
export function hideFileExtensionDropdown() {
    if (DOM.fileExtensionDropdown) {
        DOM.fileExtensionDropdown.style.display = 'none';
    }
    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.setAttribute('aria-expanded', 'false');
    }
}

// ==================== 后缀：提示文本 ====================

/**
 * 更新输入框的 placeholder 与 title。
 */
export function updateFileExtensionPlaceholder() {
    if (!DOM.fileExtensionInput) return;
    const currentLanguage = EditorState.currentLanguage;
    const validList = LANGUAGE_VALID_EXTENSIONS[currentLanguage];
    const hasFixedCollection = Array.isArray(validList) && validList.length > 0;

    if (hasFixedCollection) {
        DOM.fileExtensionInput.placeholder = validList[0];
        DOM.fileExtensionInput.title = '当前语言可选后缀：' + validList.join(' / ');
    } else {
        DOM.fileExtensionInput.placeholder = '后缀';
        DOM.fileExtensionInput.title = '输入自定义后缀（不能使用其他语言的后缀；输入过的后缀会出现在下拉历史中）';
    }
}

// ==================== 后缀：初始化 ====================

/**
 * 初始化自定义文件后缀输入框。
 */
export function initializeFileExtensionInput() {
    if (!DOM.fileExtensionInput) return;
    if (isFileExtensionInputInitialized) return;
    isFileExtensionInputInitialized = true;

    // ---- 1. 恢复 languageExtensionMap ----
    const savedMap = loadFromLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, null);
    if (savedMap && typeof savedMap === 'object' && !Array.isArray(savedMap)) {
        EditorState.languageExtensionMap = savedMap;
    } else {
        EditorState.languageExtensionMap = {};
    }

    // ---- 2. 恢复 TXT 后缀历史 ----
    loadTxtExtensionHistory();

    // ---- 3. 兼容 v8.4.1：单一后缀值迁移为 TXT 的初始值 ----
    let oldFileExtensionKeyExists = false;
    try {
        oldFileExtensionKeyExists = localStorage.getItem(STORAGE_KEYS.FILE_EXTENSION) !== null;
    } catch (readError) {
        // 静默
    }
    if (oldFileExtensionKeyExists) {
        const oldSingleExtension = loadFromLocalStorage(STORAGE_KEYS.FILE_EXTENSION, '');
        if (oldSingleExtension && !EditorState.languageExtensionMap.txt) {
            const sanitizedOld = sanitizeFileExtension(oldSingleExtension);
            if (sanitizedOld && !isExtensionUsedByOtherLanguage('txt', sanitizedOld)) {
                EditorState.languageExtensionMap.txt = sanitizedOld;
                addTxtExtensionHistoryItem(sanitizedOld);
            }
        }
        try {
            localStorage.removeItem(STORAGE_KEYS.FILE_EXTENSION);
        } catch (removeError) {
            // 静默
        }
    }

    // ---- 4. 全量校正 languageExtensionMap 中的非法值 ----
    const allLanguageKeys = Object.keys(LANGUAGE_VALID_EXTENSIONS);
    let mapWasCorrected = false;
    for (let index = 0; index < allLanguageKeys.length; index++) {
        const languageKey = allLanguageKeys[index];
        const correctedValue = resolveExtensionForLanguage(languageKey);
        if (EditorState.languageExtensionMap[languageKey] !== correctedValue) {
            EditorState.languageExtensionMap[languageKey] = correctedValue;
            mapWasCorrected = true;
        }
    }
    for (let index = 0; index < allLanguageKeys.length; index++) {
        const languageKey = allLanguageKeys[index];
        if (EditorState.languageExtensionMap[languageKey] === undefined) {
            EditorState.languageExtensionMap[languageKey] = AUTO_EXTENSION_BY_LANGUAGE[languageKey] || '';
            mapWasCorrected = true;
        }
    }
    if (mapWasCorrected) {
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
    }

    // ---- 5. 清理已废弃的 FILE_EXTENSION_HISTORY 键 ----
    try {
        if (localStorage.getItem(STORAGE_KEYS.FILE_EXTENSION_HISTORY) !== null) {
            localStorage.removeItem(STORAGE_KEYS.FILE_EXTENSION_HISTORY);
        }
    } catch (cleanupError) {
        // 静默
    }

    // ---- 6. 应用到当前语言 ----
    updateFileExtensionForLanguage(EditorState.currentLanguage);

    // ---- 7. input 事件：净化显示 + 乐观写入 + 标记未提交 ----
    DOM.fileExtensionInput.addEventListener('input', function() {
        if (isSanitizingFileExtension) return;

        const rawValue = this.value;
        const sanitizedValue = sanitizeFileExtension(rawValue);
        if (rawValue !== sanitizedValue) {
            const cursorPosition = this.selectionStart;
            const rawBeforeCursor = rawValue.slice(0, cursorPosition);
            const sanitizedBeforeCursor = sanitizeFileExtension(rawBeforeCursor);
            const newCursorPosition = sanitizedBeforeCursor.length;

            isSanitizingFileExtension = true;
            try {
                this.value = sanitizedValue;
                try {
                    this.setSelectionRange(newCursorPosition, newCursorPosition);
                } catch (selectionError) {
                    // 忽略
                }
            } finally {
                isSanitizingFileExtension = false;
            }
        }

        // 乐观写入 map（不做历史记录；历史在 change/Enter/blur 提交时记录）
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[EditorState.currentLanguage] = sanitizedValue;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

        // 标记为"已变更但未提交"
        fileExtensionValueCommitted = false;
    });

    // ---- 8. focus 事件：记录快照 + 重置提交标记 ----
    DOM.fileExtensionInput.addEventListener('focus', function() {
        fileExtensionFocusSnapshot =
            EditorState.languageExtensionMap[EditorState.currentLanguage] || '';
        // 刚聚焦时，值尚未变更，视为已提交
        fileExtensionValueCommitted = true;
        showFileExtensionDropdown();
    });

    // ---- 9. change 事件：校验入口 ----
    DOM.fileExtensionInput.addEventListener('change', function() {
        const sanitizedValue = sanitizeFileExtension(this.value);
        if (this.value !== sanitizedValue) {
            this.value = sanitizedValue;
        }
        commitFileExtensionValue(sanitizedValue);
    });

    // ---- 10. click 事件：显示下拉 ----
    DOM.fileExtensionInput.addEventListener('click', function() {
        showFileExtensionDropdown();
    });

    // ---- 11. blur 事件：隐藏下拉 + 补提交（本次重构关键修复） ----
    // 修复 P2：若用户在输入后未失焦就点击其它控件（如下载按钮、语言下拉），
    //          焦点转移会触发 blur；此时若 fileExtensionValueCommitted === false，
    //          说明用户输入的值尚未提交（未经过 change / Enter），
    //          需要在这里补一次 commitFileExtensionValue，
    //          确保值写入历史。
    //
    // 为什么不在 blur 里无条件调用 commitFileExtensionValue？
    //   · Enter 提交后紧接着 this.blur()，committed 已为 true，不会重复；
    //   · 点击下拉项后 handleExtensionItemSelect 已将 committed 置 true；
    //   · 只有在"用户输入后未提交即失焦"这一种情况下 committed 才为 false；
    //   · 用标记判断是精确、无副作用的做法。
    DOM.fileExtensionInput.addEventListener('blur', function() {
        hideFileExtensionDropdown();

        if (!fileExtensionValueCommitted) {
            const sanitizedValue = sanitizeFileExtension(this.value);
            if (this.value !== sanitizedValue) {
                this.value = sanitizedValue;
            }
            commitFileExtensionValue(sanitizedValue);
        }
    });

    // ---- 12. keydown 事件：Escape / Enter ----
    DOM.fileExtensionInput.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            hideFileExtensionDropdown();
            this.blur();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const sanitizedValue = sanitizeFileExtension(this.value);
            if (this.value !== sanitizedValue) {
                this.value = sanitizedValue;
            }
            commitFileExtensionValue(sanitizedValue);
            this.blur();
            return;
        }
    });

    // ---- 13. 全局 mousedown（点击外部关闭下拉） ----
    document.addEventListener('mousedown', function(event) {
        if (!DOM.fileExtensionInput) return;
        const wrapperElement = document.getElementById('fileExtensionWrapper');
        if (!wrapperElement) return;
        if (!wrapperElement.contains(event.target)) {
            hideFileExtensionDropdown();
        }
    });

    // ---- 14. 全局 keydown（Escape 关闭下拉） ----
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            if (DOM.fileExtensionDropdown && DOM.fileExtensionDropdown.style.display !== 'none') {
                hideFileExtensionDropdown();
            }
        }
    });
}

/**
 * 提交后缀值的统一入口（change / Enter / blur 三路共用）。
 *
 * 逻辑：
 *   · 若 value 合法：
 *       - 更新 map；
 *       - 若当前语言为 TXT 且 value 非空 → 加入 TXT 历史；
 *       - 标记 fileExtensionValueCommitted = true；
 *   · 若 value 非法：
 *       - 回滚到 fileExtensionFocusSnapshot；
 *       - Toast 提示；
 *       - 标记 fileExtensionValueCommitted = true（回滚后状态已稳定）。
 */
function commitFileExtensionValue(value) {
    const currentLanguage = EditorState.currentLanguage;

    if (isExtensionAllowedForLanguage(currentLanguage, value)) {
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[currentLanguage] = value;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

        // TXT 自由模式：值非空时加入历史
        if (currentLanguage === 'txt' && value) {
            addTxtExtensionHistoryItem(value);
        }

        updateFileExtensionPlaceholder();
        fileExtensionValueCommitted = true;
        return;
    }

    // 非法：恢复显示 + Toast 提示
    if (value) {
        if (isExtensionUsedByOtherLanguage(currentLanguage, value)) {
            showToast('ℹ️ "' + value + '" 是其他语言的后缀，已恢复上次有效值', true);
        } else {
            showToast('ℹ️ "' + value + '" 不是有效的后缀，已恢复上次有效值', true);
        }
    }

    const restoredValue = isExtensionAllowedForLanguage(currentLanguage, fileExtensionFocusSnapshot)
        ? fileExtensionFocusSnapshot
        : (AUTO_EXTENSION_BY_LANGUAGE[currentLanguage] || '');

    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }
    EditorState.languageExtensionMap[currentLanguage] = restoredValue;
    saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.value = restoredValue;
    }
    updateFileExtensionPlaceholder();
    fileExtensionValueCommitted = true;
}

// ==================== 下载 ====================

/**
 * 计算导出时实际使用的编码显示名。
 */
function resolveEncodingDisplayName(encoding) {
    if (encoding === 'ansi') {
        const actualEncoding = resolveActualAnsiEncoding();
        if (actualEncoding === 'ascii') {
            return 'ANSI (回退 ASCII)';
        }
        return ENCODING_DISPLAY_NAMES['ansi'] || 'ANSI (系统默认)';
    }
    return ENCODING_DISPLAY_NAMES[encoding] || encoding;
}

/**
 * 下载 / 保存文件。
 *
 * 后缀决策：
 *   1. 从 EditorState.languageExtensionMap 读取记忆值；
 *   2. 二次校验：若记忆值非法（如 TXT 未失焦时乐观写入的 py），
 *      回退到语言默认后缀并提示；
 *   3. 记忆值为空 → 使用 LANGUAGE_EXTENSIONS[language] 兜底。
 *
 * 注：blur 事件已保证点击"下载"按钮前，输入框的值会先经过 commit，
 *     因此此处读到的 map 值是"已提交"状态，历史同步完整。
 *
 * 编码决策：
 *   1. 用户显式选择的编码优先；
 *   2. 当前编码为 'auto' 时按扩展名推荐；
 *   3. 'gbk' 不支持时明确提示用户；
 *   4. 'ansi' 不做硬预检（内部软回退），但会 info 提示。
 */
async function handleDownloadClick() {
    const currentCode = DOM.codeEditor.value;
    if (!currentCode.trim()) {
        showToast('⚠️ 编辑器为空，无法下载', true);
        return;
    }

    const currentLanguage = EditorState.currentLanguage;
    const languageDefaultExtension = LANGUAGE_EXTENSIONS[currentLanguage] || 'txt';

    // ---- 1. 从记忆读取后缀（含二次校验） ----
    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }
    let fileExtension = EditorState.languageExtensionMap[currentLanguage] || '';

    if (fileExtension && !isExtensionAllowedForLanguage(currentLanguage, fileExtension)) {
        showToast(
            'ℹ️ 输入的后缀 "' + fileExtension + '" 无效，已使用默认后缀 .' + languageDefaultExtension,
            true
        );
        fileExtension = '';
    }

    if (!fileExtension) {
        fileExtension = languageDefaultExtension;
    }

    const mimeType = (fileExtension === languageDefaultExtension)
        ? (MIME_TYPES[currentLanguage] || 'text/plain')
        : 'text/plain';

    // ---- 2. 解析导出编码 ----
    let exportEncoding = EditorState.currentEncoding;
    if (exportEncoding === 'auto') {
        const normalizedExtension = fileExtension.toLowerCase();
        exportEncoding = EXTENSION_DEFAULT_ENCODING[normalizedExtension] || 'utf-8';
        updateEncodingStatusOnly(exportEncoding);
        showToast('当前为自动检测，导出使用 ' + resolveEncodingDisplayName(exportEncoding));
    }

    // ---- 3. GBK 可用性预检 ----
    if (exportEncoding === 'gbk' && !isGBKSupported()) {
        const gbkErrorMessage = getGBKSupportError() || '当前浏览器不支持 GBK 编码';
        const fallbackToUtf8 = confirm(
            '⚠️ ' + gbkErrorMessage + '。\n\n' +
            '如果保存为 GBK 的文件在 Windows 记事本中打开，将显示为乱码。\n\n' +
            '点击"确定"：改用 UTF-8 编码下载（推荐）\n' +
            '点击"取消"：取消本次下载'
        );
        if (!fallbackToUtf8) return;
        exportEncoding = 'utf-8';
        updateEncodingStatusOnly(exportEncoding);
        showToast('已改用 UTF-8 编码下载');
    }

    if (exportEncoding === 'ansi' && !isGBKSupported()) {
        showToast('ℹ️ ANSI 回退为 ASCII（当前浏览器不支持 GBK）');
    }

    // ---- 4. 编码为字节流 ----
    let encodedBytes;
    try {
        encodedBytes = encodeTextToBytes(currentCode, exportEncoding);
    } catch (encodeError) {
        console.error('编码失败:', encodeError);
        showToast('❌ 编码失败：' + (encodeError.message || '未知错误'), true);
        return;
    }

    // ---- 5. 计算最终显示的编码名 ----
    const finalEncodingDisplayName = resolveEncodingDisplayName(exportEncoding);

    // ---- 6. 尝试获取目录句柄 ----
    let directoryHandle = null;
    if (window.showDirectoryPicker) {
        try {
            directoryHandle = await getOrCreateSaveDirectory();
        } catch (dirError) {
            if (dirError && dirError.name === 'AbortError') {
                return;
            }
            if (dirError && dirError.name === 'NotAllowedError') {
                showToast('⚠️ 目录权限已失效，已切换为浏览器下载', true);
                try {
                    await clearDirectoryHandle();
                } catch (clearError) {
                    // 忽略
                }
            } else {
                console.error('获取保存目录失败，已切换为浏览器下载:', dirError);
            }
            directoryHandle = null;
        }
    }

    // ---- 7. 只 prompt 一次文件名 ----
    const lastFilename = loadFromLocalStorage(STORAGE_KEYS.LAST_DOWNLOAD_FILENAME, 'code');
    const userInputFilename = prompt(
        '请输入文件名（无需后缀，将自动使用 .' + fileExtension + '）:',
        lastFilename
    );
    if (userInputFilename === null) return;

    const safeFilename = sanitizeFilename(userInputFilename);
    if (safeFilename && safeFilename !== 'code' && userInputFilename.trim()) {
        saveToLocalStorage(STORAGE_KEYS.LAST_DOWNLOAD_FILENAME, safeFilename);
    }
    const finalFilename = safeFilename + '.' + fileExtension;

    // ---- 8. 优先走目录保存 ----
    if (directoryHandle) {
        try {
            await writeFileToDirectory(directoryHandle, finalFilename, encodedBytes);
            showToast(
                '💾 已保存 "' + finalFilename + '" 到上次选择的目录 (' +
                finalEncodingDisplayName + ')'
            );
            return;
        } catch (writeError) {
            if (writeError && writeError.name === 'NotAllowedError') {
                showToast('⚠️ 目录权限已失效，已切换为浏览器下载', true);
                try {
                    await clearDirectoryHandle();
                } catch (clearError) {
                    // 忽略
                }
            } else {
                console.error('写入目录失败，已切换为浏览器下载:', writeError);
            }
        }
    }

    // ---- 9. 回退到浏览器下载 ----
    const blob = new Blob([encodedBytes], { type: mimeType });
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = finalFilename;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadUrl);
    showToast('💾 已下载 ' + finalFilename + ' (' + finalEncodingDisplayName + ')');
}

// ==================== 下载事件绑定 ====================

export function bindDownloadEvents() {
    DOM.btnDownload.addEventListener('click', handleDownloadClick);
}