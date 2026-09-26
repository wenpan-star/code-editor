// filename: js/file-io.js
/**
 * ============================================================================
 * file-io.js — 文件导入 / 下载 / 拖拽 / 后缀约束
 * ============================================================================
 *
 * 【本次重构（后缀系统闭环补丁）】
 *
 *   修复上一轮审核发现的两处 P1 与两处 P2 问题：
 *
 *   1. P1 Bug 1 — TXT 自由模式下无法清空后缀输入框
 *      根因：isExtensionAllowedForLanguage 把空字符串一律视为非法，
 *            导致用户清空后触发 change 时被"恢复上次有效值"。
 *      修复：将语义拆分为"受约束模式 / 自由模式"两种判断：
 *            · 受约束模式（集合非空）→ 空值非法（不允许清空）；
 *            · 自由模式（集合为空，仅 TXT）→ 空值合法（无自定义后缀）。
 *
 *   2. P1 Bug 2 — 下载路径绕过跨语言校验
 *      根因：handleDownloadClick 直接读输入框 DOM 值（getCustomFileExtension），
 *            在用户输入后未失焦时点下载可绕过 change 事件里的合法性校验。
 *      修复：改为读 EditorState.languageExtensionMap（记忆值），
 *            再做一次 isExtensionAllowedForLanguage 二次校验，
 *            非法则回退默认后缀并提示。
 *
 *   3. P2 问题 3 — TXT 输入后未失焦不持久化
 *      根因：原实现在 input 事件只净化显示、不写记忆，
 *            只在 change / Enter 时写入；
 *            用户输入后立即关闭标签页 / 直接点下载时输入丢失。
 *      修复：
 *            · input 事件立即乐观写入 EditorState.languageExtensionMap；
 *            · focus 事件记录快照 fileExtensionFocusSnapshot；
 *            · change 事件校验，非法时回滚到快照；
 *            · 下次启动时 initializeFileExtensionInput 全量校正会清理
 *              极端场景（乐观写入非法值后立即崩溃）残留的非法值。
 *
 *   4. P2 问题 4 — 切换语言时输入框焦点未处理
 *      根因：updateFileExtensionForLanguage 更新输入框值与 readOnly，
 *            但若焦点仍在输入框，readOnly 变化后键盘输入无效，
 *            视觉上却像可编辑，用户困惑。
 *      修复：更新前若输入框有焦点则主动 blur。
 *
 *   本次修复不改变任何导出接口签名，不改变 DOM 结构，不改变存储键，
 *   不改变 UI 文案语义，仅补强已有逻辑。
 *
 * 【保留的既有设计（不修改）】
 *   · 后缀合法集合由 config.js 的 LANGUAGE_VALID_EXTENSIONS 唯一声明；
 *   · 记忆由 EditorState.languageExtensionMap 唯一承担；
 *   · 导入文件时不更新记忆（导入是"高亮选择"不是"后缀选择"）；
 *   · 启动时一次性清理 FILE_EXTENSION_HISTORY 与 v8.4.1 单一后缀键；
 *   · readOnly 由"集合是否为空"决定。
 *
 * 【删除的导出接口（上一轮已废弃，本轮保持）】
 *   · loadFileExtensionHistory
 *   · saveFileExtensionHistory
 *   · addToFileExtensionHistory
 *   · removeFromFileExtensionHistory
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
// 用途：change 事件校验失败时回滚到该快照（而不是回滚到可能已被
//        input 事件乐观写入的当前 map 值）。
// 生命周期：
//   · focus → 记录当时 map 中的合法值；
//   · change 校验失败 → 用快照覆盖 map 与输入框显示；
//   · 无 focus 而直接 change（理论不会发生）→ 保持上次快照。
let fileExtensionFocusSnapshot = '';

/**
 * 所有语言合法后缀的并集（预计算 Set）。
 *
 * 用途：将"某个后缀是否被其他语言占用"的判断从 O(n × 集合长度)
 * 降为 O(1) 查询。仅包含非空集合（TXT 的 [] 不贡献任何元素）。
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
 *   1. BOM 检测：决定"本次文件的实际编码"。
 *      · 若 EditorState.currentEncoding === 'auto' → 同步下拉框与持久化；
 *      · 若用户显式选择 → 仅更新状态栏，不改用户选择。
 *   2. 若当前编码为 'auto'，按扩展名推荐编码（.bat/.cmd → 'ansi'）；
 *   3. 若仍未定编码，按 UTF-8 有效性检测。
 *
 * 后缀记忆行为：
 *   · 导入文件**不更新** languageExtensionMap；
 *   · 理由：导入的语言选择是"高亮选择"，不是"后缀选择"；
 *   · 用户导入 .spec 时不应该让 Python 后缀记忆变为 'spec'。
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

        // ---- 编码决策 ----
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

        // ---- 解码 ----
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
            // switchLanguage 内部通过回调触发 updateFileExtensionForLanguage，
            // 后者使用 resolveExtensionForLanguage 保证后缀框只显示合法值；
            // 本次导入不写入 languageExtensionMap，避免污染后缀记忆。
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
 *   - 去除首尾空白
 *   - 去除所有前导点号
 *   - 移除非字母 / 数字 / 连字符 / 下划线字符
 *   - 统一转小写
 *   - 截断到 CONFIG.FILE_EXTENSION_MAX_LENGTH
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
 * 从输入框读取当前后缀（已净化）。
 *
 * 注意：本函数只做字符净化，**不校验合法性**。
 *       调用方若需要合法值，请使用 EditorState.languageExtensionMap
 *       或再调用 isExtensionAllowedForLanguage 二次校验。
 *       保留此函数供未来可能的外部调用者使用，内部代码已不再依赖它。
 */
export function getCustomFileExtension() {
    if (!DOM.fileExtensionInput) return '';
    return sanitizeFileExtension(DOM.fileExtensionInput.value);
}

// ==================== 后缀：合法性与占用校验 ====================

/**
 * 判断后缀是否被其他语言占用。
 *
 * 用于自由输入模式（TXT）下的跨语言占用校验。
 * 使用预计算 Set 实现 O(1) 判断。
 */
function isExtensionUsedByOtherLanguage(language, extension) {
    if (!extension) return false;
    if (!ALL_RESERVED_EXTENSIONS.has(extension)) return false;
    // 若该后缀同时属于当前语言的合法集合，则不算"被其他语言占用"
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    if (Array.isArray(validList) && validList.indexOf(extension) !== -1) {
        return false;
    }
    return true;
}

/**
 * 综合判定：后缀是否可以在该语言下使用。
 *
 * 分两种模式（本次重构的关键语义修正）：
 *
 *   1. 受约束模式（LANGUAGE_VALID_EXTENSIONS[language] 非空）：
 *      · 空值视为非法（不允许清空，语义上必须有后缀）；
 *      · 非空值必须严格属于合法集合。
 *
 *   2. 自由模式（集合为空，当前仅 TXT）：
 *      · 空值视为合法（表示"无自定义后缀"）；
 *      · 非空值必须不被其他语言占用。
 *
 * 修正说明：
 *   上一轮实现将所有空值一律视为非法，导致 TXT 模式下用户清空
 *   输入框后触发 change 时被回滚到上次值，永远无法回到空状态。
 *   本次修正区分两种模式：TXT 允许空，受约束语言不允许空。
 */
function isExtensionAllowedForLanguage(language, extension) {
    const validList = LANGUAGE_VALID_EXTENSIONS[language];

    // ---- 受约束模式 ----
    if (Array.isArray(validList) && validList.length > 0) {
        if (!extension) return false;
        return validList.indexOf(extension) !== -1;
    }

    // ---- 自由模式（集合为空） ----
    if (!extension) return true;
    return !isExtensionUsedByOtherLanguage(language, extension);
}

/**
 * 从记忆恢复语言的有效后缀（所有设置后缀路径的统一入口）。
 *
 * 逻辑：
 *   1. 若 languageExtensionMap 缺失或结构损坏 → 视为空对象；
 *   2. 读取 memoryValue = languageExtensionMap[language]；
 *   3. 若合法 → 返回 memoryValue；
 *   4. 若非法 → 返回 AUTO_EXTENSION_BY_LANGUAGE[language]（默认值）。
 *
 * 该函数保证：
 *   · 无论存储在 map 中的历史值如何（旧版自定义 / 跨语言污染），
 *     返回值一定是当前语言下的合法后缀（或 TXT 下的空值）；
 *   · 未来新增语言无需改动此逻辑。
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

// ==================== 后缀：语言切换联动 ====================

/**
 * 语言切换时更新后缀框。
 *
 * 关键步骤：
 *   1. 若输入框当前有焦点，先主动 blur；
 *      （避免输入框 readOnly 状态变化后键盘输入无效而视觉上仍似可编辑）
 *   2. 使用 resolveExtensionForLanguage 恢复有效值（含非法值回退）；
 *   3. 根据"集合是否为空"设置 readOnly；
 *   4. 更新 placeholder / title；
 *   5. 隐藏下拉（切换语言后下拉不应保持打开）；
 *   6. 持久化 map。
 */
export function updateFileExtensionForLanguage(language) {
    if (!DOM.fileExtensionInput) return;

    // ---- 1. 主动失焦（P2 问题 4 修复） ----
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
}

// ==================== 后缀：下拉渲染 ====================

/**
 * 渲染后缀下拉列表。
 *
 * 数据源：LANGUAGE_VALID_EXTENSIONS[当前语言]（唯一权威）。
 * 无历史、无合并、无过滤、无删除按钮。
 */
function renderFileExtensionDropdown() {
    if (!DOM.fileExtensionDropdown) return;

    const currentLanguage = EditorState.currentLanguage;
    const validList = LANGUAGE_VALID_EXTENSIONS[currentLanguage];

    // 自由模式（集合为空）→ 不显示下拉
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

/**
 * 下拉项被选中后的处理。
 *
 * 由于数据源就是合法集合，选中项必然合法，无需二次校验。
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
}

/**
 * 显示后缀下拉列表。
 *
 * 前置条件：当前语言的合法集合非空（受约束模式）。
 * 自由模式调用此函数无副作用（直接隐藏）。
 */
export function showFileExtensionDropdown() {
    if (!DOM.fileExtensionInput) return;
    const currentLanguage = EditorState.currentLanguage;
    const validList = LANGUAGE_VALID_EXTENSIONS[currentLanguage];
    if (!Array.isArray(validList) || validList.length === 0) {
        hideFileExtensionDropdown();
        return;
    }
    renderFileExtensionDropdown();
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
 *
 * 受约束模式（集合非空）：
 *   · placeholder = 默认后缀（集合第 0 项）
 *   · title = "当前语言可选后缀：py / pyw"
 *
 * 自由模式（集合为空）：
 *   · placeholder = '后缀'
 *   · title = '输入自定义后缀（不能使用其他语言的后缀）'
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
        DOM.fileExtensionInput.title = '输入自定义后缀（不能使用其他语言的后缀）';
    }
}

// ==================== 后缀：初始化 ====================

/**
 * 初始化自定义文件后缀输入框。
 *
 * 关键步骤：
 *   1. 从 localStorage 恢复 languageExtensionMap（结构容错）；
 *   2. 兼容 v8.4.1 单一后缀键（迁移到 TXT）；
 *   3. 全量校正 map 中的非法值（一次性清理）；
 *   4. 补齐所有语言键（避免 undefined）；
 *   5. 应用当前语言；
 *   6. 绑定 input / change / focus / click / blur / keydown 事件；
 *   7. 绑定全局 mousedown / keydown 事件（下拉关闭）；
 *   8. 清理已废弃的 FILE_EXTENSION_HISTORY 键。
 *
 * 事件语义（本次重构后）：
 *   · input  → 净化显示 + 乐观写入 map；
 *   · focus  → 记录快照（供 change 校验失败时回滚）；
 *   · change → 校验：合法保持、非法回滚到快照 + Toast 提示；
 *   · Enter  → 同 change；
 *   · Escape → 关闭下拉并 blur。
 */
export function initializeFileExtensionInput() {
    if (!DOM.fileExtensionInput) return;
    if (isFileExtensionInputInitialized) return;
    isFileExtensionInputInitialized = true;

    // ---- 1. 恢复映射 ----
    const savedMap = loadFromLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, null);
    if (savedMap && typeof savedMap === 'object' && !Array.isArray(savedMap)) {
        EditorState.languageExtensionMap = savedMap;
    } else {
        EditorState.languageExtensionMap = {};
    }

    // ---- 2. 兼容 v8.4.1：单一后缀值迁移为 TXT 的初始值 ----
    let oldFileExtensionKeyExists = false;
    try {
        oldFileExtensionKeyExists = localStorage.getItem(STORAGE_KEYS.FILE_EXTENSION) !== null;
    } catch (readError) {
        // localStorage 不可用时静默忽略
    }
    if (oldFileExtensionKeyExists) {
        const oldSingleExtension = loadFromLocalStorage(STORAGE_KEYS.FILE_EXTENSION, '');
        if (oldSingleExtension && !EditorState.languageExtensionMap.txt) {
            const sanitizedOld = sanitizeFileExtension(oldSingleExtension);
            // 迁移时校验跨语言占用：若旧值恰是其他语言的保留后缀，
            // 直接丢弃，避免污染 TXT 的记忆。
            if (sanitizedOld && !isExtensionUsedByOtherLanguage('txt', sanitizedOld)) {
                EditorState.languageExtensionMap.txt = sanitizedOld;
            }
        }
        try {
            localStorage.removeItem(STORAGE_KEYS.FILE_EXTENSION);
        } catch (removeError) {
            // 静默
        }
    }

    // ---- 3. 全量校正已保存的 map（清理旧版遗留的非法值） ----
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
    // 补齐未定义的语言键
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

    // ---- 4. 清理已废弃的 FILE_EXTENSION_HISTORY 键 ----
    try {
        if (localStorage.getItem(STORAGE_KEYS.FILE_EXTENSION_HISTORY) !== null) {
            localStorage.removeItem(STORAGE_KEYS.FILE_EXTENSION_HISTORY);
        }
    } catch (cleanupError) {
        // 静默
    }

    // ---- 5. 应用到当前语言 ----
    updateFileExtensionForLanguage(EditorState.currentLanguage);

    // ---- 6. input 事件：净化显示 + 乐观写入 ----
    // 修复 P2 问题 3：TXT 输入后未失焦不持久化。
    // 现在 input 事件立即写入 map，即使未失焦也持久化；
    // 若写入的值非法，change 事件会在失焦时回滚到 focus 时的快照。
    DOM.fileExtensionInput.addEventListener('input', function() {
        if (isSanitizingFileExtension) return;

        const rawValue = this.value;
        const sanitizedValue = sanitizeFileExtension(rawValue);
        if (rawValue !== sanitizedValue) {
            // 精确计算光标位置（对「光标前子串」独立净化）
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

        // 乐观写入：即便用户未失焦，也持久化当前输入。
        // 非法值将由 change 事件回滚；极端场景（乐观写入后立即崩溃）
        // 残留的非法值由下次启动的全量校正清理。
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[EditorState.currentLanguage] = sanitizedValue;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
    });

    // ---- 7. focus 事件：记录快照 ----
    // 用于 change 校验失败时回滚到"聚焦时的合法值"。
    DOM.fileExtensionInput.addEventListener('focus', function() {
        fileExtensionFocusSnapshot =
            EditorState.languageExtensionMap[EditorState.currentLanguage] || '';
        showFileExtensionDropdown();
    });

    // ---- 8. change 事件：校验入口 ----
    DOM.fileExtensionInput.addEventListener('change', function() {
        const sanitizedValue = sanitizeFileExtension(this.value);
        if (this.value !== sanitizedValue) {
            this.value = sanitizedValue;
        }
        commitFileExtensionValue(sanitizedValue);
    });

    // ---- 9. click 事件：显示下拉 ----
    DOM.fileExtensionInput.addEventListener('click', function() {
        showFileExtensionDropdown();
    });

    // ---- 10. blur 事件：隐藏下拉 ----
    DOM.fileExtensionInput.addEventListener('blur', function() {
        hideFileExtensionDropdown();
    });

    // ---- 11. keydown 事件：Escape / Enter ----
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

    // ---- 12. 全局 mousedown（点击外部关闭下拉） ----
    document.addEventListener('mousedown', function(event) {
        if (!DOM.fileExtensionInput) return;
        const wrapperElement = document.getElementById('fileExtensionWrapper');
        if (!wrapperElement) return;
        if (!wrapperElement.contains(event.target)) {
            hideFileExtensionDropdown();
        }
    });

    // ---- 13. 全局 keydown（Escape 关闭下拉） ----
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            if (DOM.fileExtensionDropdown && DOM.fileExtensionDropdown.style.display !== 'none') {
                hideFileExtensionDropdown();
            }
        }
    });
}

/**
 * 提交后缀值的统一入口（change / Enter 共用）。
 *
 * 逻辑：
 *   · 若 value 合法 → 保持（map 已被 input 事件乐观写入同值）；
 *   · 若 value 非法 → 回滚到 fileExtensionFocusSnapshot + Toast 提示。
 *
 * 为什么回滚而不是清空？
 *   · 用户输入非法值时，最有用的行为是"恢复到之前的合法选择"；
 *   · 清空会导致 TXT 丢失之前的自定义后缀，受约束语言会丢失当前选择；
 *   · 回滚到聚焦时的快照，用户能清晰看到"我原来的值还在"。
 */
function commitFileExtensionValue(value) {
    const currentLanguage = EditorState.currentLanguage;

    if (isExtensionAllowedForLanguage(currentLanguage, value)) {
        // 合法：input 事件已写入 map，这里只需保证持久化与提示同步。
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[currentLanguage] = value;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
        updateFileExtensionPlaceholder();
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

    // 回滚到聚焦时的快照（该值一定合法，因为它来自记忆恢复后的合法值）
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
 * 后缀决策（本次重构后的关键路径）：
 *   1. 从 EditorState.languageExtensionMap 读取记忆值（已通过 resolve 校验）；
 *   2. **二次校验**：若记忆值非法（例如用户在 TXT 输入 py 后未失焦
 *      直接点击下载，input 事件已乐观写入 map），回退到语言默认后缀
 *      并给出提示；
 *   3. 若记忆值为空（TXT 未输入），使用 LANGUAGE_EXTENSIONS[language] 兜底。
 *
 * 为什么不再读输入框 DOM 值（getCustomFileExtension）？
 *   · 输入框的值可能未经过 change 校验（用户输入后未失焦）；
 *   · 直接读 DOM 会绕过跨语言占用校验，导致 TXT 生成 .py 文件；
 *   · 记忆值才是"已校验的权威来源"。
 *
 * 编码决策：
 *   1. 用户显式选择的编码优先；
 *   2. 当前编码为 'auto' 时按扩展名推荐编码；
 *   3. 'gbk' 不支持时明确提示用户选择降级方案；
 *   4. 'ansi' 不做硬预检（内部软回退），但会 info 提示。
 *
 * 保存路径：
 *   1. 先尝试获取目录句柄（成功与否决定后续分支）；
 *   2. 用户取消目录选择 → 整个流程终止；
 *   3. 目录写入失败 → 回退浏览器下载；
 *   4. 只 prompt 一次文件名，两个分支共用。
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

    // 二次校验：拦截未失焦时乐观写入的非法值
    if (fileExtension && !isExtensionAllowedForLanguage(currentLanguage, fileExtension)) {
        showToast(
            'ℹ️ 输入的后缀 "' + fileExtension + '" 无效，已使用默认后缀 .' + languageDefaultExtension,
            true
        );
        fileExtension = '';
    }

    // 兜底默认
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

    // ---- 3.1 'ansi' 回退提示 ----
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