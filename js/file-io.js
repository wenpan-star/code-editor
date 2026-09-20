// filename: js/file-io.js
/**
 * ============================================================================
 * file-io.js — 文件导入 / 下载 / 拖拽 / 后缀联动 / 历史下拉
 * ============================================================================
 *
 * 【本次更新】
 *   仅在文件首行补充 // filename: js/file-io.js 标注，与项目约定统一。
 *   内容逻辑保持不变。
 *
 * 本模块职责：
 *   1. 导入：读取 ArrayBuffer → BOM 检测 → 编码解析 → 解码 → 设置内容
 *   2. 导出：编码文本 → 优先写入已选目录 → 否则触发浏览器下载
 *   3. 拖拽：监听 editorWrapper 的 dragover / drop
 *   4. 后缀联动：语言切换时后缀自动跟随；每语言独立保存后缀
 *   5. 历史下拉：显示"预设候选 + 历史记录"，单击项 = 选择；单击 × = 删除
 *
 * 依赖：
 *   - state.js / config.js / dom.js / toast.js / util.js
 *   - editor-api.js（setEditorContent / switchLanguage / updateFileNameDisplay）
 *   - encoding.js（BOM / UTF-8 有效性 / 编解码 / 编码 UI / ANSI 实际编码解析）
 *   - gbk-codec.js（GBK 支持性探测）
 *   - directory-io.js（保存目录获取）
 *   - storage.js（writeFileToDirectory / clearDirectoryHandle）
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
    LANGUAGE_ALLOW_CUSTOM_EXTENSION,
    LANGUAGE_SHOW_HISTORY_DROPDOWN,
    LANGUAGE_PRESET_EXTENSIONS,
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

// ==================== 模块级标志 ====================

// 输入净化标志：程序化修改 value 期间置位，防止二次 input 事件重复处理。
let isSanitizingFileExtension = false;

// 幂等保护标志：防止 initializeFileExtensionInput 被重复调用。
let isFileExtensionInputInitialized = false;

// ==================== 导入 ====================

/**
 * 加载文件到编辑器。
 *
 * 编码决策顺序（当前编码为 'auto' 时）：
 *   1. BOM 检测优先（最可靠）
 *   2. 扩展名推荐编码（.bat/.cmd → 'ansi'）
 *   3. UTF-8 有效性检测（不通过则警告用户）
 *
 * 当前编码非 'auto' 时，直接使用用户选择的编码。
 *
 * 'gbk' 与 'ansi' 的处理差异：
 *   · 'gbk'   —— 不支持时硬报错，降级为 UTF-8
 *   · 'ansi'  —— 不支持时软回退 ASCII，并给出 info 提示
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
        let finalEncoding = EditorState.currentEncoding;

        // ---- 编码决策 ----
        if (detectedBomEncoding) {
            // 1. BOM 检测优先
            finalEncoding = detectedBomEncoding;
            updateEncodingDisplay(finalEncoding);
            showToast('📂 检测到编码: ' + ENCODING_DISPLAY_NAMES[finalEncoding]);
        } else if (finalEncoding === 'auto') {
            // 2. 当前为自动检测
            const fileExtension = file.name.split('.').pop().toLowerCase();
            const recommendedEncoding = EXTENSION_DEFAULT_ENCODING[fileExtension];

            if (recommendedEncoding === 'ansi') {
                // .bat / .cmd：使用 ANSI（简体中文 Windows 上即 GBK）
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
                // 扩展名未推荐特殊编码，且字节流是有效 UTF-8
                finalEncoding = 'utf-8';
                updateEncodingStatusOnly(finalEncoding);
                showToast('📂 未检测到 BOM，默认使用 UTF-8');
            } else {
                // 字节流不是有效 UTF-8，提示用户
                finalEncoding = 'utf-8';
                updateEncodingStatusOnly(finalEncoding);
                showToast(
                    '⚠️ 字节流不是有效的 UTF-8，可能是其他编码（如 GBK），请手动选择',
                    true
                );
            }
        } else {
            // 3. 用户显式选择了编码
            if (finalEncoding === 'gbk' && !isGBKSupported()) {
                // 明确选择的 'gbk' 不支持时硬报错
                showToast('⚠️ 当前浏览器不支持 GBK 解码，将按 UTF-8 处理', true);
                finalEncoding = 'utf-8';
            }
            if (finalEncoding === 'ansi' && !isGBKSupported()) {
                // 用户显式选择 'ansi' 但 GBK 不支持，提示回退
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

        // 补传 finalCursorStart / finalCursorEnd 为 (0, 0)，
        // 使导入后的光标位于文档开头而非末尾。
        setEditorContent(decodedText, true, false, 0, 0);
        updateFileNameDisplay(file.name);

        const fileExtension = file.name.split('.').pop().toLowerCase();
        if (EXTENSION_LANGUAGE_MAP[fileExtension]) {
            // switchLanguage 内部已通过回调自动调用 updateFileExtensionForLanguage
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
 */
export function getCustomFileExtension() {
    if (!DOM.fileExtensionInput) return '';
    return sanitizeFileExtension(DOM.fileExtensionInput.value);
}

// ==================== 后缀：历史记录管理 ====================

/**
 * 读取历史后缀列表。
 * 从 localStorage 读取原始数组，逐项净化、去重、按字母排序。
 */
export function loadFileExtensionHistory() {
    const rawHistory = loadFromLocalStorage(STORAGE_KEYS.FILE_EXTENSION_HISTORY, []);
    if (!Array.isArray(rawHistory)) return [];

    const sanitizedSet = new Set();
    for (let index = 0; index < rawHistory.length; index++) {
        const sanitized = sanitizeFileExtension(rawHistory[index]);
        if (sanitized) {
            sanitizedSet.add(sanitized);
        }
    }

    return Array.from(sanitizedSet).sort(function(a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    });
}

/**
 * 将历史后缀列表写回 localStorage。
 */
export function saveFileExtensionHistory(historyArray) {
    if (!Array.isArray(historyArray)) {
        saveToLocalStorage(STORAGE_KEYS.FILE_EXTENSION_HISTORY, []);
        return;
    }

    const sanitizedSet = new Set();
    for (let index = 0; index < historyArray.length; index++) {
        const sanitized = sanitizeFileExtension(historyArray[index]);
        if (sanitized) {
            sanitizedSet.add(sanitized);
        }
    }

    const sortedHistory = Array.from(sanitizedSet).sort(function(a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    });

    const limitedHistory = sortedHistory.slice(0, CONFIG.FILE_EXTENSION_HISTORY_MAX);
    saveToLocalStorage(STORAGE_KEYS.FILE_EXTENSION_HISTORY, limitedHistory);
}

/**
 * 将新后缀加入历史记录。若已存在则忽略。
 */
export function addToFileExtensionHistory(extensionText) {
    const sanitized = sanitizeFileExtension(extensionText);
    if (!sanitized) return;

    const currentHistory = loadFileExtensionHistory();
    if (currentHistory.indexOf(sanitized) !== -1) {
        return;
    }
    currentHistory.push(sanitized);
    saveFileExtensionHistory(currentHistory);
}

/**
 * 从历史记录中移除指定后缀。
 */
export function removeFromFileExtensionHistory(extensionText) {
    const sanitized = sanitizeFileExtension(extensionText);
    if (!sanitized) return;

    const currentHistory = loadFileExtensionHistory();
    const filteredHistory = currentHistory.filter(function(item) {
        return item !== sanitized;
    });
    if (filteredHistory.length !== currentHistory.length) {
        saveFileExtensionHistory(filteredHistory);
    }
}

/**
 * 合并"预设候选"与"历史记录"。
 *
 * 合并规则：
 *   · 预设在前 —— 让用户一眼看到"官方推荐"；
 *   · 历史在后 —— 用户自己输入过的排到预设后面；
 *   · 净化 + 去重 —— 保证渲染列表干净；
 *   · 单项长度超限的项自动丢弃（sanitizeFileExtension 已截断，
 *     但若截断后为空则丢弃）。
 *
 * @param {string} language - 当前语言
 * @returns {string[]} 合并后的候选后缀数组
 */
function buildMergedExtensionCandidates(language) {
    const presetList = LANGUAGE_PRESET_EXTENSIONS[language] || [];
    const historyList = loadFileExtensionHistory();

    const seen = new Set();
    const mergedList = [];

    function pushItem(rawItem) {
        const sanitized = sanitizeFileExtension(rawItem);
        if (!sanitized) return;
        if (seen.has(sanitized)) return;
        seen.add(sanitized);
        mergedList.push(sanitized);
    }

    for (let i = 0; i < presetList.length; i++) pushItem(presetList[i]);
    for (let i = 0; i < historyList.length; i++) pushItem(historyList[i]);

    return mergedList;
}

// ==================== 后缀：语言切换联动 ====================

/**
 * 语言切换时更新后缀框。
 *
 * 逻辑：
 *   1. 读取 EditorState.languageExtensionMap[language]；
 *      若未定义，使用 AUTO_EXTENSION_BY_LANGUAGE[language] 作为初值。
 *   2. 净化该值。
 *   3. 应用到输入框。
 *   4. 根据 LANGUAGE_ALLOW_CUSTOM_EXTENSION 设置 readOnly。
 *   5. 刷新 placeholder / title。
 *   6. 隐藏历史下拉（语言切换后不应保持打开）。
 *   7. 持久化映射。
 */
export function updateFileExtensionForLanguage(language) {
    if (!DOM.fileExtensionInput) return;

    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }

    // 若该语言无记录，用默认值
    if (EditorState.languageExtensionMap[language] === undefined) {
        EditorState.languageExtensionMap[language] = AUTO_EXTENSION_BY_LANGUAGE[language] || '';
    }

    // 净化（防止历史遗留非法值）
    const sanitizedValue = sanitizeFileExtension(EditorState.languageExtensionMap[language]);
    EditorState.languageExtensionMap[language] = sanitizedValue;

    // 应用到输入框
    DOM.fileExtensionInput.value = sanitizedValue;

    // 更新 readOnly（用 readOnly 而非 disabled，保留视觉与 hover 反馈）
    const allowCustom = LANGUAGE_ALLOW_CUSTOM_EXTENSION[language] === true;
    DOM.fileExtensionInput.readOnly = !allowCustom;

    // 刷新提示
    updateFileExtensionPlaceholder();

    // 隐藏历史下拉
    hideFileExtensionDropdown();

    // 持久化映射
    saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
}

// ==================== 后缀：下拉渲染（× 删除按钮） ====================

/**
 * 渲染历史后缀下拉列表。
 *
 * 候选来源从"仅历史"改为"预设 + 历史"合并（见 buildMergedExtensionCandidates）。
 * 这样 Python 语言放开自定义后，用户点击后缀框立即能看到 py / pyw。
 *
 * 结构：
 *   · filterText 用于按输入过滤（小写包含匹配）。
 *   · 每项结构：<span class="file-extension-dropdown-item-text">value</span>
 *               <span class="file-extension-dropdown-item-delete">×</span>
 *   · 单击项 = 选择；单击 × = 删除（删除仅作用于历史记录，
 *     预设项删除后再次聚焦会由 buildMergedExtensionCandidates 重新补回，
 *     这符合"预设值不可删除"的语义）。
 */
function renderFileExtensionDropdown(filterText) {
    if (!DOM.fileExtensionDropdown) return;

    // 仅允许显示历史下拉的语言才渲染
    const currentLang = EditorState.currentLanguage;
    if (!LANGUAGE_SHOW_HISTORY_DROPDOWN[currentLang]) {
        DOM.fileExtensionDropdown.style.display = 'none';
        if (DOM.fileExtensionInput) {
            DOM.fileExtensionInput.setAttribute('aria-expanded', 'false');
        }
        return;
    }

    // 合并预设 + 历史
    const mergedCandidates = buildMergedExtensionCandidates(currentLang);

    const dropdownElement = DOM.fileExtensionDropdown;
    dropdownElement.innerHTML = '';

    const normalizedFilter = (typeof filterText === 'string') ? filterText.toLowerCase() : '';
    const filteredCandidates = normalizedFilter
        ? mergedCandidates.filter(function(item) {
            return item.toLowerCase().indexOf(normalizedFilter) !== -1;
        })
        : mergedCandidates;

    if (filteredCandidates.length === 0) {
        dropdownElement.style.display = 'none';
        if (DOM.fileExtensionInput) {
            DOM.fileExtensionInput.setAttribute('aria-expanded', 'false');
        }
        return;
    }

    const currentValue = getCustomFileExtension();
    const presetList = LANGUAGE_PRESET_EXTENSIONS[currentLang] || [];
    const presetSanitizedSet = new Set();
    for (let i = 0; i < presetList.length; i++) {
        const s = sanitizeFileExtension(presetList[i]);
        if (s) presetSanitizedSet.add(s);
    }

    for (let index = 0; index < filteredCandidates.length; index++) {
        const extensionValue = filteredCandidates[index];
        const isPresetItem = presetSanitizedSet.has(extensionValue);

        const itemElement = document.createElement('div');
        itemElement.className = 'file-extension-dropdown-item';
        itemElement.setAttribute('role', 'option');
        itemElement.setAttribute('data-value', extensionValue);

        // 文本部分
        const textElement = document.createElement('span');
        textElement.className = 'file-extension-dropdown-item-text';
        textElement.textContent = extensionValue;
        itemElement.appendChild(textElement);

        // × 删除按钮（预设项不显示删除按钮，避免误删预设候选）
        if (!isPresetItem) {
            const deleteButtonElement = document.createElement('span');
            deleteButtonElement.className = 'file-extension-dropdown-item-delete';
            deleteButtonElement.textContent = '×';
            deleteButtonElement.title = '删除该历史后缀';
            deleteButtonElement.addEventListener('mousedown', function(event) {
                // 用 mousedown 而非 click：避免与项自身的 mousedown 冲突。
                event.preventDefault();
                event.stopPropagation();
                removeFromFileExtensionHistory(extensionValue);
                // 刷新下拉，保持输入框当前值的过滤状态
                const currentInputValue = DOM.fileExtensionInput ? DOM.fileExtensionInput.value : '';
                showFileExtensionDropdown(currentInputValue);
            });
            itemElement.appendChild(deleteButtonElement);

            // 项本身的点击（选择）—— 需要跳过 × 按钮
            itemElement.addEventListener('mousedown', function(event) {
                if (event.target === deleteButtonElement) return;
                handleExtensionItemSelect(this, extensionValue);
            });
        } else {
            // 预设项：点击即选择
            itemElement.addEventListener('mousedown', function(event) {
                event.preventDefault();
                event.stopPropagation();
                handleExtensionItemSelect(this, extensionValue);
            });
        }

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
 * 下拉项被选中后的公共处理。
 * 预设项与历史项共用同一段逻辑。
 */
function handleExtensionItemSelect(itemElement, selectedValue) {
    if (DOM.fileExtensionInput) {
        DOM.fileExtensionInput.value = selectedValue;
        DOM.fileExtensionInput.focus();
    }
    if (!EditorState.languageExtensionMap
        || typeof EditorState.languageExtensionMap !== 'object') {
        EditorState.languageExtensionMap = {};
    }
    EditorState.languageExtensionMap[EditorState.currentLanguage] = selectedValue;
    saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);
    updateFileExtensionPlaceholder();
    hideFileExtensionDropdown();
}

/**
 * 显示历史后缀下拉列表。
 * 前置条件：当前语言允许显示历史下拉（内部会二次检查）。
 */
export function showFileExtensionDropdown(filterText) {
    if (!DOM.fileExtensionInput) return;
    const currentLang = EditorState.currentLanguage;
    if (!LANGUAGE_SHOW_HISTORY_DROPDOWN[currentLang]) {
        hideFileExtensionDropdown();
        return;
    }
    const filter = (typeof filterText === 'string') ? filterText : '';
    renderFileExtensionDropdown(filter);
}

/**
 * 隐藏历史后缀下拉列表。
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
 * 更新输入框的 placeholder 与 title，使其反映当前语言的可用性。
 */
export function updateFileExtensionPlaceholder() {
    if (!DOM.fileExtensionInput) return;
    const currentLang = EditorState.currentLanguage;
    const autoExtension = AUTO_EXTENSION_BY_LANGUAGE[currentLang] || '';
    const allowCustom = LANGUAGE_ALLOW_CUSTOM_EXTENSION[currentLang] === true;
    const showHistory = LANGUAGE_SHOW_HISTORY_DROPDOWN[currentLang] === true;

    if (!allowCustom) {
        // JS / CSS / JV：后缀固定只读
        DOM.fileExtensionInput.placeholder = autoExtension;
        DOM.fileExtensionInput.title = '当前语言后缀固定为 .' + autoExtension;
    } else if (currentLang === 'txt') {
        // TXT：自由输入 + 历史下拉
        DOM.fileExtensionInput.placeholder = '后缀';
        DOM.fileExtensionInput.title = '输入自定义后缀（回车 / 失焦后记入历史；点击可选择历史后缀）';
    } else {
        // HTML / Python：默认值可修改；支持历史下拉
        DOM.fileExtensionInput.placeholder = autoExtension;
        DOM.fileExtensionInput.title = showHistory
            ? '默认 .' + autoExtension + '（可修改；点击可选择历史后缀）'
            : '默认 .' + autoExtension + '（可修改）';
    }
}

// ==================== 后缀：初始化 ====================

/**
 * 初始化自定义文件后缀输入框。
 *
 * 幂等保护：重复调用直接返回。
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

    // ---- 2. 兼容 v8.4.1：将单一后缀值迁移为 TXT 语言的初始值 ----
    let oldFileExtensionKeyExists = false;
    try {
        oldFileExtensionKeyExists = localStorage.getItem(STORAGE_KEYS.FILE_EXTENSION) !== null;
    } catch (readError) {
        // localStorage 不可用时静默忽略（键视为不存在）
    }
    if (oldFileExtensionKeyExists) {
        const oldSingleExtension = loadFromLocalStorage(STORAGE_KEYS.FILE_EXTENSION, '');
        if (oldSingleExtension && !EditorState.languageExtensionMap.txt) {
            const sanitizedOld = sanitizeFileExtension(oldSingleExtension);
            if (sanitizedOld) {
                EditorState.languageExtensionMap.txt = sanitizedOld;
            }
        }
        try {
            localStorage.removeItem(STORAGE_KEYS.FILE_EXTENSION);
        } catch (removeError) {
            // localStorage 不可用时静默忽略
        }
    }

    // ---- 3. 补齐所有语言 ----
    const allLanguages = ['js', 'html', 'css', 'python', 'java', 'txt'];
    for (let index = 0; index < allLanguages.length; index++) {
        const lang = allLanguages[index];
        if (EditorState.languageExtensionMap[lang] === undefined) {
            EditorState.languageExtensionMap[lang] = AUTO_EXTENSION_BY_LANGUAGE[lang] || '';
        }
    }

    // ---- 4. 应用到输入框 ----
    updateFileExtensionForLanguage(EditorState.currentLanguage);

    // ---- 5. input 事件 ----
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

        // 更新 map
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[EditorState.currentLanguage] = this.value;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

        updateFileExtensionPlaceholder();

        // 显示历史下拉
        if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage]) {
            showFileExtensionDropdown(this.value);
        }
    });

    // ---- 6. change 事件：历史记录入口 ----
    DOM.fileExtensionInput.addEventListener('change', function() {
        const sanitizedValue = sanitizeFileExtension(this.value);
        if (this.value !== sanitizedValue) {
            this.value = sanitizedValue;
        }
        if (!EditorState.languageExtensionMap
            || typeof EditorState.languageExtensionMap !== 'object') {
            EditorState.languageExtensionMap = {};
        }
        EditorState.languageExtensionMap[EditorState.currentLanguage] = sanitizedValue;
        saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

        // 把后缀写入历史
        if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage] && sanitizedValue) {
            addToFileExtensionHistory(sanitizedValue);
        }
        updateFileExtensionPlaceholder();
    });

    // ---- 7. focus / click ----
    DOM.fileExtensionInput.addEventListener('focus', function() {
        if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage]) {
            showFileExtensionDropdown();
        }
    });
    DOM.fileExtensionInput.addEventListener('click', function() {
        if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage]) {
            showFileExtensionDropdown();
        }
    });

    // ---- 8. blur ----
    DOM.fileExtensionInput.addEventListener('blur', function() {
        hideFileExtensionDropdown();
    });

    // ---- 9. keydown ----
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
            if (!EditorState.languageExtensionMap
                || typeof EditorState.languageExtensionMap !== 'object') {
                EditorState.languageExtensionMap = {};
            }
            EditorState.languageExtensionMap[EditorState.currentLanguage] = sanitizedValue;
            saveToLocalStorage(STORAGE_KEYS.LANGUAGE_EXTENSION_MAP, EditorState.languageExtensionMap);

            if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage] && sanitizedValue) {
                addToFileExtensionHistory(sanitizedValue);
            }
            updateFileExtensionPlaceholder();
            this.blur();
            return;
        }
    });

    // ---- 10. 全局 mousedown ----
    document.addEventListener('mousedown', function(event) {
        if (!DOM.fileExtensionInput) return;
        const wrapperElement = document.getElementById('fileExtensionWrapper');
        if (!wrapperElement) return;
        if (!wrapperElement.contains(event.target)) {
            hideFileExtensionDropdown();
        }
    });

    // ---- 11. 全局 keydown（Escape 关闭下拉） ----
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            if (DOM.fileExtensionDropdown && DOM.fileExtensionDropdown.style.display !== 'none') {
                hideFileExtensionDropdown();
            }
        }
    });
}

// ==================== 下载 ====================

/**
 * 计算导出时实际使用的编码显示名。
 *
 * 'ansi' 语义上是"系统默认"，但实际编码取决于浏览器：
 *   · GBK 支持    → 实际为 GBK，显示 "ANSI (系统默认)"
 *   · GBK 不支持  → 回退 ASCII，显示 "ANSI (回退 ASCII)"
 *
 * 其他编码值直接返回显示名。
 *
 * @param {string} encoding 逻辑编码值（用户选择或扩展名推荐的）
 * @returns {string}
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
 *   1. 用户显式选择的编码优先
 *   2. 当前编码为 'auto' 时按扩展名推荐编码
 *      · .bat / .cmd → 'ansi'（系统默认，简中 Windows 上 = GBK）
 *      · .py / .pyw / .spec / .md / .json / .html / .htm → UTF-8（.pyw 走兜底）
 *      · 其他 → UTF-8
 *   3. 'gbk' 不支持时明确提示用户选择降级方案
 *   4. 'ansi' 不做硬预检（内部软回退），但会 info 提示
 *
 * 保存路径：
 *   1. 优先使用目录句柄（getOrCreateSaveDirectory）
 *   2. 用户取消或目录不可用 → 回退浏览器下载
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

    // ---- 2. HTML / TXT / Python 语言把当前值作为历史写入 ----
    if (LANGUAGE_SHOW_HISTORY_DROPDOWN[EditorState.currentLanguage] && fileExtension) {
        addToFileExtensionHistory(fileExtension);
    }

    // ---- 3. 解析导出编码 ----
    let exportEncoding = EditorState.currentEncoding;
    if (exportEncoding === 'auto') {
        // 按扩展名推荐编码
        const normalizedExtension = fileExtension.toLowerCase();
        exportEncoding = EXTENSION_DEFAULT_ENCODING[normalizedExtension] || 'utf-8';
        updateEncodingStatusOnly(exportEncoding);
        showToast('当前为自动检测，导出使用 ' + resolveEncodingDisplayName(exportEncoding));
    }

    // ---- 4. GBK 可用性预检（仅对明确要求的 'gbk' 提示） ----
    // 'ansi' 不做硬预检：内部软回退 ASCII，无需 confirm 打扰
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

    // ---- 4.1 'ansi' 回退提示 ----
    // 用户显式选择或扩展名推荐 'ansi' 但 GBK 不支持时，提前告知用户
    if (exportEncoding === 'ansi' && !isGBKSupported()) {
        showToast('ℹ️ ANSI 回退为 ASCII（当前浏览器不支持 GBK）');
    }

    // ---- 5. 编码为字节流 ----
    let encodedBytes;
    try {
        encodedBytes = encodeTextToBytes(currentCode, exportEncoding);
    } catch (encodeError) {
        console.error('编码失败:', encodeError);
        showToast('❌ 编码失败：' + (encodeError.message || '未知错误'), true);
        return;
    }

    // ---- 6. 计算最终显示的编码名（反映实际使用的编码） ----
    const finalEncodingDisplayName = resolveEncodingDisplayName(exportEncoding);

    // ---- 7. 优先走目录保存 ----
    if (window.showDirectoryPicker) {
        try {
            const directoryHandle = await getOrCreateSaveDirectory();

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
            await writeFileToDirectory(directoryHandle, finalFilename, encodedBytes);
            showToast(
                '💾 已保存 "' + finalFilename + '" 到上次选择的目录 (' +
                finalEncodingDisplayName + ')'
            );
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            if (err && err.name === 'NotAllowedError') {
                showToast('⚠️ 目录权限已失效，已切换为浏览器下载', true);
                try {
                    await clearDirectoryHandle();
                } catch (clearError) {
                    // 忽略
                }
            } else {
                console.error('保存失败:', err);
            }
        }
    }

    // ---- 8. 回退到浏览器下载 ----
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

/**
 * 绑定下载按钮。
 *
 * "更改保存位置" / "打开保存位置" 按钮由 directory-io.js 的
 * bindDirectoryIOEvents 负责绑定。
 */
export function bindDownloadEvents() {
    DOM.btnDownload.addEventListener('click', handleDownloadClick);
}