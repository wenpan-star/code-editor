// filename: js/file-io.js
/**
 * ============================================================================
 * file-io.js — 文件导入 / 下载 / 拖拽 / 后缀约束
 * ============================================================================
 *
 * 【本次重构】
 *   后缀系统从"预设 + 全局历史"重构为"权威合法集合 + 每语言记忆"。
 *
 *   1. 根因诊断：
 *      · 原实现的下拉数据源 = LANGUAGE_PRESET_EXTENSIONS + FILE_EXTENSION_HISTORY；
 *      · FILE_EXTENSION_HISTORY 是全局数组，无语言隔离；
 *      · TXT 输入 'py' 后，'py' 进入全局历史，导致 HTML / JS / CSS / Java
 *        的下拉都会出现 'py'；
 *      · 反向亦然：Python 下拉可能出现 'bat' / 'html' / 'md' 等。
 *      结果：违背"相应语言只能是相应的后缀"的语义。
 *
 *   2. 新模型：
 *      · LANGUAGE_VALID_EXTENSIONS（来自 config.js）为唯一权威来源；
 *      · 彻底废弃 FILE_EXTENSION_HISTORY 及其全部读写函数；
 *      · 记忆结构 EditorState.languageExtensionMap 保持不变，
 *        但所有读取路径经 resolveExtensionForLanguage 统一校验，
 *        保证非法值（旧版遗留 / 跨语言）一律回退到默认值；
 *      · 新增跨语言占用校验 isExtensionUsedByOtherLanguage，
 *        供 TXT 自由输入模式使用；
 *      · 预计算 ALL_RESERVED_EXTENSIONS Set，将占用校验从 O(n) 降到 O(1)。
 *
 *   3. UI 模式自动切换：
 *      · 集合非空 → 受约束模式（readOnly + 下拉选择）；
 *      · 集合为空 → 自由模式（可编辑 + 失焦校验）。
 *
 *   4. 一次性数据清理：
 *      · 启动时删除历史遗留的 FILE_EXTENSION_HISTORY 键；
 *      · 同时全量校正 languageExtensionMap 中可能存在的非法值。
 *
 *   5. 保留全部原有导出接口与行为（除已废弃的历史函数）：
 *      bindImportEvents / bindDragAndDropEvents / bindDownloadEvents /
 *      sanitizeFileExtension / getCustomFileExtension /
 *      updateFileExtensionForLanguage / showFileExtensionDropdown /
 *      hideFileExtensionDropdown / updateFileExtensionPlaceholder /
 *      initializeFileExtensionInput。
 *
 * 【删除的导出接口（已无调用方）】
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
 * 后缀记忆行为（本次重构后）：
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
            // switchLanguage 内部会通过回调自动调用 updateFileExtensionForLanguage
            // 后者使用 resolveExtensionForLanguage，保证后缀框只显示合法值。
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
 * 不校验合法性：合法性由 updateFileExtensionForLanguage 与输入事件保证。
 */
export function getCustomFileExtension() {
    if (!DOM.fileExtensionInput) return '';
    return sanitizeFileExtension(DOM.fileExtensionInput.value);
}

// ==================== 后缀：合法性与占用校验 ====================

/**
 * 判断后缀是否属于该语言的合法集合。
 *
 * 语义：
 *   · 空后缀 → false（任何语言都不接受空作为"合法后缀"）；
 *   · 集合非空 → 严格集合成员判断；
 *   · 集合为空（TXT）→ 返回 true，
 *     交由 isExtensionAllowedForLanguage 做进一步的跨语言占用校验。
 */
function isValidExtensionForLanguage(language, extension) {
    if (!extension) return false;
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    if (!Array.isArray(validList)) return false;
    if (validList.length === 0) return true;
    return validList.indexOf(extension) !== -1;
}

/**
 * 判断后缀是否被其他语言占用。
 *
 * 用于 TXT 自由输入场景：TXT 不能输入 py / html / js 等已被其他语言
 * 声明的后缀，否则会导致跨语言语义混淆。
 *
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
 * 分两种模式：
 *   · 受约束模式（集合非空）→ 只需在集合内；
 *   · 自由模式（集合为空）  → 只要不被其他语言占用即可。
 */
function isExtensionAllowedForLanguage(language, extension) {
    if (!extension) return false;
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    if (Array.isArray(validList) && validList.length > 0) {
        return validList.indexOf(extension) !== -1;
    }
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
 *     返回值一定是当前语言下的合法后缀；
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
 * 关键变化（本次重构）：
 *   · 使用 resolveExtensionForLanguage 校验记忆值，
 *     非法值自动回退到默认；
 *   · readOnly 由"集合是否为空"决定，不再依赖废弃常量；
 *   · 若该语言为新语言（无记忆），用 AUTO_EXTENSION_BY_LANGUAGE 初始化。
 */
export function updateFileExtensionForLanguage(language) {
    if (!DOM.fileExtensionInput) return;

    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }

    // 通过统一入口恢复有效值（内部会处理"未定义 / 非法"两种情况）
    const resolvedValue = resolveExtensionForLanguage(language);
    EditorState.languageExtensionMap[language] = resolvedValue;

    DOM.fileExtensionInput.value = resolvedValue;

    // 根据集合是否为空设置 readOnly
    const validList = LANGUAGE_VALID_EXTENSIONS[language];
    const hasFixedCollection = Array.isArray(validList) && validList.length > 0;
    DOM.fileExtensionInput.readOnly = hasFixedCollection;

    updateFileExtensionPlaceholder();
    hideFileExtensionDropdown();

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
 * 简单逻辑：写入记忆 + 更新输入框 + 隐藏下拉。
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

    // ---- 6. input 事件 ----
    // 说明：受约束语言 input 事件不触发（readOnly）；
    //       TXT 自由输入模式下，input 仅净化显示，不写入 map；
    //       真正的合法性校验在 change / Enter 时进行。
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
        // 注意：不在此处写入 languageExtensionMap，避免乐观写入非法值。
        // 合法性判断与写入统一在 change / Enter 时执行。
    });

    // ---- 7. change 事件：合法性校验入口 ----
    DOM.fileExtensionInput.addEventListener('change', function() {
        const sanitizedValue = sanitizeFileExtension(this.value);
        if (this.value !== sanitizedValue) {
            this.value = sanitizedValue;
        }
        commitFileExtensionValue(sanitizedValue);
    });

    // ---- 8. focus / click ----
    DOM.fileExtensionInput.addEventListener('focus', function() {
        showFileExtensionDropdown();
    });
    DOM.fileExtensionInput.addEventListener('click', function() {
        showFileExtensionDropdown();
    });

    // ---- 9. blur ----
    DOM.fileExtensionInput.addEventListener('blur', function() {
        hideFileExtensionDropdown();
    });

    // ---- 10. keydown ----
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

    // ---- 11. 全局 mousedown（点击外部关闭下拉） ----
    document.addEventListener('mousedown', function(event) {
        if (!DOM.fileExtensionInput) return;
        const wrapperElement = document.getElementById('fileExtensionWrapper');
        if (!wrapperElement) return;
        if (!wrapperElement.contains(event.target)) {
            hideFileExtensionDropdown();
        }
    });

    // ---- 12. 全局 keydown（Escape 关闭下拉） ----
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
 *   · 若 value 合法 → 写入 languageExtensionMap，保持输入框显示；
 *   · 若 value 非法 → 恢复输入框显示为记忆中的合法值，并 Toast 提示。
 *
 * 为什么非法时恢复而不是清空？
 *   · 用户输入 py 被拒绝时，我们希望恢复到"上次有效值"而非空；
 *   · 记忆中的合法值就是"上次有效值"，直接复用即可。
 */
function commitFileExtensionValue(value) {
    const currentLanguage = EditorState.currentLanguage;

    if (isExtensionAllowedForLanguage(currentLanguage, value)) {
        // 合法：写入记忆
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

    const lastValidValue = EditorState.languageExtensionMap[currentLanguage] || '';
    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.value = lastValidValue;
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

    // ---- 1. 确定文件后缀 ----
    const languageDefaultExtension = LANGUAGE_EXTENSIONS[EditorState.currentLanguage] || 'txt';
    let fileExtension = getCustomFileExtension();
    if (!fileExtension) {
        fileExtension = languageDefaultExtension;
    }
    const mimeType = (fileExtension === languageDefaultExtension)
        ? (MIME_TYPES[EditorState.currentLanguage] || 'text/plain')
        : 'text/plain';

    // 注：本次重构已废弃 addToFileExtensionHistory 调用。
    //     后缀记忆仅由 languageExtensionMap 承担，
    //     下载时不再向全局历史写入。

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