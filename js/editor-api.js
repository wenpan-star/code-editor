// filename: js/editor-api.js
/**
 * ============================================================================
 * editor-api.js — 统一编辑入口 / 状态协调层
 * ============================================================================
 *
 * 【本次重构】
 *   1. 自动保存状态颜色恢复（P2）：
 *      原实现在成功时把 autoSaveStatus 置为绿色，2 秒后只改文字，
 *      不恢复颜色。失败变红后若后续成功，颜色可能残留。
 *
 *      新行为：
 *        · 定义辅助函数 restoreAutoSaveStatusToDefault，
 *          把文字重置为 '自动保存'、颜色重置为 var(--text-secondary)；
 *        · 成功路径：文字 '已自动保存' + 绿色，2 秒后恢复默认；
 *        · 失败路径：文字 '保存失败' + 红色，不自动恢复（保留警示）；
 *        · 本地降级：文字 '已保存(本地)' + 黄色 var(--warning)；
 *        · 大文件未保存：文字 '大文件未保存' + 红色。
 *
 *   2. 保留全部原有导出接口与行为：
 *      setUpdateMatchCountCallback / setUpdateFileExtensionCallback /
 *      setEditorContent / executeCodeModification / fullUpdate /
 *      debouncedUpdate / updateRunButtonState / toggleClearButton /
 *      markModified / clearModifiedMark / setOriginalCode /
 *      updateFileNameDisplay / triggerAutoSave / saveImmediately /
 *      emergencySave / loadSavedCode / handleUndo / handleRedo /
 *      updateUndoRedoState / switchLanguage。
 *
 *   3. A1 修复保留：flushPendingHistoryIfNeeded 在撤销/重做前强制落盘。
 * ============================================================================
 */

import { EditorState } from './state.js';
import {
    CONFIG,
    STORAGE_KEYS,
    LANGUAGE_DISPLAY_NAMES,
    DEFAULT_CODE_BY_LANGUAGE
} from './config.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { saveToLocalStorage, loadFromLocalStorage } from './util.js';
import { historyManager } from './history.js';
import { updateLineNumbers, updateCursorPosition } from './line-numbers.js';
import { scheduleHighlightUpdate, setHighlightEnabled } from './highlight.js';
import { closeOutputPanel } from './output.js';
import { saveCodeToIndexedDB, loadCodeFromIndexedDB } from './storage.js';

// ==================== 注入的回调 ====================

// 匹配计数防抖回调（来自 search.js 的 updateMatchCountDebounced）。
let updateMatchCountCallback = null;

// 后缀联动回调（来自 file-io.js 的 updateFileExtensionForLanguage）。
let updateFileExtensionCallback = null;

/**
 * main.js 注入 updateMatchCountDebounced（来自 search.js）。
 * 注入的应是防抖版本，确保 fullUpdate 触发的匹配计数
 * 也走 150ms 防抖，避免被绕过。
 */
export function setUpdateMatchCountCallback(callback) {
    updateMatchCountCallback = callback;
}

/**
 * main.js 注入 updateFileExtensionForLanguage（来自 file-io.js）。
 * 注入后，任何调用 switchLanguage 的路径都会自动同步后缀框。
 */
export function setUpdateFileExtensionCallback(callback) {
    updateFileExtensionCallback = callback;
}

// ==================== 自动保存状态显示 ====================

// 自动保存状态默认文字与颜色。
// 成功短暂提示后，恢复到此默认状态。
const AUTO_SAVE_DEFAULT_TEXT = '自动保存';
const AUTO_SAVE_DEFAULT_COLOR = 'var(--text-secondary)';
const AUTO_SAVE_SUCCESS_COLOR = 'var(--green)';
const AUTO_SAVE_WARNING_COLOR = 'var(--warning)';
const AUTO_SAVE_ERROR_COLOR = 'var(--red)';
const AUTO_SAVE_SUCCESS_DISPLAY_MS = 2000;

/**
 * 恢复自动保存状态为默认文字与颜色。
 * 由成功提示的 2 秒定时器调用。
 */
function restoreAutoSaveStatusToDefault() {
    if (!DOM.autoSaveStatus) return;
    DOM.autoSaveStatus.textContent = AUTO_SAVE_DEFAULT_TEXT;
    DOM.autoSaveStatus.style.color = AUTO_SAVE_DEFAULT_COLOR;
}

/**
 * 显示自动保存成功状态（绿色），并在 AUTO_SAVE_SUCCESS_DISPLAY_MS
 * 后恢复默认状态。
 */
function showAutoSaveSuccessStatus(text) {
    if (!DOM.autoSaveStatus) return;
    DOM.autoSaveStatus.textContent = text;
    DOM.autoSaveStatus.style.color = AUTO_SAVE_SUCCESS_COLOR;
    setTimeout(restoreAutoSaveStatusToDefault, AUTO_SAVE_SUCCESS_DISPLAY_MS);
}

/**
 * 显示自动保存失败状态（红色），不自动恢复。
 * 由下次成功自动保存覆盖。
 */
function showAutoSaveFailureStatus(text) {
    if (!DOM.autoSaveStatus) return;
    DOM.autoSaveStatus.textContent = text;
    DOM.autoSaveStatus.style.color = AUTO_SAVE_ERROR_COLOR;
}

/**
 * 显示自动保存降级状态（黄色），不自动恢复。
 * 用于 IndexedDB 失败但 localStorage 成功的场景。
 */
function showAutoSaveDegradedStatus(text) {
    if (!DOM.autoSaveStatus) return;
    DOM.autoSaveStatus.textContent = text;
    DOM.autoSaveStatus.style.color = AUTO_SAVE_WARNING_COLOR;
}

// ==================== 待处理历史定时器 ====================

/**
 * 若存在尚未落盘的历史快照定时器（普通键盘输入的防抖），
 * 立即触发一次 pushState 把当前编辑状态写入历史栈。
 *
 * 目的：让"用户输入后立刻按 Ctrl+Z"能够撤销本次输入。
 */
function flushPendingHistoryIfNeeded() {
    if (EditorState.typingHistoryDebounceTimer !== null) {
        clearTimeout(EditorState.typingHistoryDebounceTimer);
        EditorState.typingHistoryDebounceTimer = null;
        if (historyManager) {
            historyManager.pushState(DOM.codeEditor);
        }
        updateUndoRedoState();
    }
}

// ==================== 统一编辑入口 ====================

export function setEditorContent(newValue, shouldRecordHistory, preserveCursor, finalCursorStart, finalCursorEnd) {
    const shouldRecord = shouldRecordHistory !== false;
    const preserve = preserveCursor === true;
    const editor = DOM.codeEditor;
    if (!editor) return;

    if (newValue.length > EditorState.absoluteFileSizeLimit) {
        showToast('❌ 内容超过 2MB，已阻止加载以避免卡顿', true);
        return;
    }

    const oldValue = editor.value;
    if (oldValue === newValue && newValue !== '') return;

    // 程序化修改会立即 pushState，无需等待打字防抖。
    // 先取消待处理的打字历史定时器，避免与随后的 pushState 重复。
    if (EditorState.typingHistoryDebounceTimer !== null) {
        clearTimeout(EditorState.typingHistoryDebounceTimer);
        EditorState.typingHistoryDebounceTimer = null;
    }

    const isLargeFile = newValue.length > EditorState.largeFileThreshold;
    EditorState.largeFileActive = isLargeFile;

    if (historyManager) {
        historyManager.setLargeFileMode(isLargeFile);
    }

    if (isLargeFile && EditorState.highlightEnabled) {
        setHighlightEnabled(false, false);
    }

    const oldStart = editor.selectionStart;
    const oldEnd = editor.selectionEnd;

    if (shouldRecord && historyManager) {
        historyManager.pushState(editor);
    }

    editor.value = newValue;

    if (preserve && oldStart <= newValue.length) {
        editor.setSelectionRange(
            Math.min(oldStart, newValue.length),
            Math.min(oldEnd, newValue.length)
        );
    } else if (
        finalCursorStart !== null && finalCursorStart !== undefined &&
        finalCursorEnd !== null && finalCursorEnd !== undefined &&
        finalCursorStart <= newValue.length && finalCursorEnd <= newValue.length
    ) {
        editor.setSelectionRange(finalCursorStart, finalCursorEnd);
    }

    EditorState.internalEditorUpdate = true;
    try {
        const inputEvent = new Event('input', { bubbles: true });
        editor.dispatchEvent(inputEvent);
    } finally {
        EditorState.internalEditorUpdate = false;
    }

    fullUpdate();
    triggerAutoSave();
    toggleClearButton();

    if (shouldRecord && historyManager) {
        historyManager.pushState(editor);
    }
}

export function executeCodeModification(modificationFunc) {
    const editor = DOM.codeEditor;
    if (EditorState.largeFileActive) {
        modificationFunc();
        fullUpdate();
        triggerAutoSave();
        return;
    }
    if (historyManager) historyManager.beginBatch();
    modificationFunc();
    if (historyManager) historyManager.endBatch(editor);
    fullUpdate();
    triggerAutoSave();
}

// ==================== 全量刷新 ====================

export function fullUpdate() {
    updateLineNumbers();
    updateCursorPosition();
    scheduleHighlightUpdate();
    if (updateMatchCountCallback) updateMatchCountCallback();
    updateRunButtonState();
}

export function debouncedUpdate() {
    if (EditorState.updateTimer) clearTimeout(EditorState.updateTimer);
    EditorState.updateTimer = setTimeout(fullUpdate, 80);
}

// ==================== 运行按钮状态 ====================

export function updateRunButtonState() {
    if (EditorState.currentLanguage === 'java') {
        DOM.btnRun.disabled = false;
    } else {
        DOM.btnRun.disabled = true;
    }
}

// ==================== 清空按钮状态 ====================

export function toggleClearButton() {
    DOM.btnClear.disabled = (DOM.codeEditor.value === '');
}

// ==================== 修改状态标记 ====================

export function markModified() {
    if (!EditorState.codeModified) {
        EditorState.codeModified = true;
        const currentModifiedDot = document.getElementById('modifiedDot');
        if (currentModifiedDot) currentModifiedDot.style.display = 'inline-block';
    }
}

export function clearModifiedMark() {
    EditorState.codeModified = false;
    const currentModifiedDot = document.getElementById('modifiedDot');
    if (currentModifiedDot) currentModifiedDot.style.display = 'none';
}

export function setOriginalCode(code) {
    EditorState.originalCode = code;
    clearModifiedMark();
}

// ==================== 文件名显示 ====================

export function updateFileNameDisplay(filename) {
    EditorState.currentFileName = filename;
    DOM.fileNameDisplay.innerHTML = '';
    const textNode = document.createTextNode(filename + ' ');
    DOM.fileNameDisplay.appendChild(textNode);
    const modifiedDotSpan = document.createElement('span');
    modifiedDotSpan.className = 'modified-dot';
    modifiedDotSpan.id = 'modifiedDot';
    modifiedDotSpan.title = '未保存的更改';
    DOM.fileNameDisplay.appendChild(modifiedDotSpan);
    const newModifiedDot = document.getElementById('modifiedDot');
    if (newModifiedDot) {
        newModifiedDot.style.display = EditorState.codeModified ? 'inline-block' : 'none';
    }
}

// ==================== 自动保存 ====================

/**
 * 触发自动保存（延迟执行，防抖）。
 *
 * 状态栏反馈：
 *   · 成功 → '已自动保存' + 绿色，2 秒后恢复默认文字与颜色；
 *   · IndexedDB 失败但 localStorage 成功 → '已保存(本地)' + 黄色；
 *   · 完全失败 → '保存失败' + 红色；
 *   · 大文件模式未保存 → '大文件未保存' + 红色。
 *
 * 所有状态显示函数集中在本模块顶部，避免颜色与文字分散在多个分支。
 */
export function triggerAutoSave() {
    if (EditorState.autoSaveTimer) clearTimeout(EditorState.autoSaveTimer);
    const delay = EditorState.largeFileActive
        ? CONFIG.AUTOSAVE_DELAY_LARGE_FILE
        : CONFIG.AUTOSAVE_DELAY_NORMAL;

    EditorState.autoSaveTimer = setTimeout(async function() {
        const currentCode = DOM.codeEditor.value;
        try {
            await saveCodeToIndexedDB(currentCode);
            if (!EditorState.largeFileActive && currentCode.length < CONFIG.AUTOSAVE_LOCAL_STORAGE_MAX_LENGTH) {
                saveToLocalStorage(STORAGE_KEYS.CODE_CACHE, currentCode);
            }
            clearModifiedMark();
            showAutoSaveSuccessStatus('已自动保存');
        } catch (error) {
            console.warn('自动保存失败', error);
            if (!EditorState.largeFileActive) {
                try {
                    saveToLocalStorage(STORAGE_KEYS.CODE_CACHE, currentCode);
                    showAutoSaveDegradedStatus('已保存(本地)');
                } catch (localError) {
                    showAutoSaveFailureStatus('保存失败');
                }
            } else {
                showAutoSaveFailureStatus('大文件未保存');
            }
            if (currentCode !== EditorState.originalCode) markModified();
        }
    }, delay);
}

export async function saveImmediately() {
    const currentCode = DOM.codeEditor.value;
    try {
        await saveCodeToIndexedDB(currentCode);
        if (!EditorState.largeFileActive && currentCode.length < CONFIG.AUTOSAVE_LOCAL_STORAGE_MAX_LENGTH) {
            saveToLocalStorage(STORAGE_KEYS.CODE_CACHE, currentCode);
        }
        setOriginalCode(currentCode);
        clearModifiedMark();
        showToast('✅ 已保存');
    } catch (error) {
        showToast('❌ 保存失败', true);
    }
}

// ==================== 紧急保存 ====================

export function emergencySave() {
    const code = DOM.codeEditor.value;
    try {
        if (!EditorState.largeFileActive) {
            saveToLocalStorage(STORAGE_KEYS.CODE_CACHE, code);
            saveToLocalStorage(STORAGE_KEYS.DIRTY_FLAG, '1');
        }
    } catch (saveError) {
        // 静默
    }
    if (EditorState.autoSaveDB) {
        const savePromise = saveCodeToIndexedDB(code);
        const timeoutPromise = new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('timeout')); }, 500);
        });
        Promise.race([savePromise, timeoutPromise]).then(function() {
            if (!EditorState.largeFileActive) {
                saveToLocalStorage(STORAGE_KEYS.DIRTY_FLAG, '0');
            }
        }).catch(function() { /* 静默 */ });
    }
}

// ==================== 恢复上次编辑 ====================

export async function loadSavedCode() {
    const wasDirty = loadFromLocalStorage(STORAGE_KEYS.DIRTY_FLAG, '0') === '1';
    if (wasDirty) {
        const cachedCode = loadFromLocalStorage(STORAGE_KEYS.CODE_CACHE, null);
        if (cachedCode && cachedCode !== DEFAULT_CODE_BY_LANGUAGE.js) {
            if (confirm('检测到上次页面异常关闭时未保存的内容，是否恢复？')) {
                setEditorContent(cachedCode, false, false, 0, 0);
                saveToLocalStorage(STORAGE_KEYS.DIRTY_FLAG, '0');
                return true;
            }
        }
        saveToLocalStorage(STORAGE_KEYS.DIRTY_FLAG, '0');
    }
    try {
        const indexedCode = await loadCodeFromIndexedDB();
        if (indexedCode !== null && indexedCode !== undefined && indexedCode !== DEFAULT_CODE_BY_LANGUAGE.js) {
            if (confirm('检测到上次未完成的编辑内容，是否恢复？')) {
                setEditorContent(indexedCode, false, false, 0, 0);
                return true;
            }
        }
    } catch (dbError) {
        // 忽略
    }
    const cachedCode = loadFromLocalStorage(STORAGE_KEYS.CODE_CACHE, null);
    if (cachedCode && cachedCode !== DEFAULT_CODE_BY_LANGUAGE.js) {
        if (confirm('检测到本地缓存的编辑内容，是否恢复？')) {
            setEditorContent(cachedCode, false, false, 0, 0);
            return true;
        }
    }
    return false;
}

// ==================== 撤销 / 重做 ====================

export function handleUndo() {
    // 先 flush 待处理的打字历史快照，
    // 否则用户在打字期间按 Ctrl+Z 会因历史栈未更新而无效。
    flushPendingHistoryIfNeeded();

    if (!historyManager) return;
    if (historyManager.undo(DOM.codeEditor)) {
        // onStateApplied（historyManager.undo 内部调用）已执行过 fullUpdate。
        triggerAutoSave();
        toggleClearButton();
    }
}

export function handleRedo() {
    // 同理：重做前也先 flush，确保当前状态被记录。
    flushPendingHistoryIfNeeded();

    if (!historyManager) return;
    if (historyManager.redo(DOM.codeEditor)) {
        triggerAutoSave();
        toggleClearButton();
    }
}

/**
 * 更新撤销/重做按钮状态。
 *
 * 考虑待处理的打字历史定时器 ——
 * 打字期间 content 已经变化，撤销按钮应立即可用。
 */
export function updateUndoRedoState() {
    if (!historyManager) return;
    const hasPendingTypingHistory = EditorState.typingHistoryDebounceTimer !== null;
    DOM.btnUndo.disabled = !historyManager.canUndo() && !hasPendingTypingHistory;
    DOM.btnRedo.disabled = !historyManager.canRedo();
}

// ==================== 语言切换 ====================

/**
 * 切换语言并同步所有相关状态。
 *
 * 本函数是"切换语言"的唯一原子操作，包括：
 *   1. 更新 EditorState.currentLanguage；
 *   2. 持久化到 localStorage；
 *   3. 同步语言下拉框 value；
 *   4. 更新状态栏语言全称；
 *   5. 调度语法高亮刷新；
 *   6. 更新运行按钮状态；
 *   7. 非 Java 语言时关闭输出面板；
 *   8. 触发后缀联动回调（若已注入）—— 保证后缀框自动跟随语言。
 */
export function switchLanguage(language) {
    EditorState.currentLanguage = language;
    saveToLocalStorage(STORAGE_KEYS.LANGUAGE, language);

    if (DOM.langSelect) {
        DOM.langSelect.value = language;
    }

    DOM.langDisplay.textContent = LANGUAGE_DISPLAY_NAMES[language] || language;

    scheduleHighlightUpdate();
    updateRunButtonState();
    if (language !== 'java' && EditorState.outputPanelOpen && !EditorState.isRunning) {
        closeOutputPanel();
    }

    if (updateFileExtensionCallback) {
        try {
            updateFileExtensionCallback(language);
        } catch (callbackError) {
            console.warn('后缀联动回调执行失败:', callbackError);
        }
    }
}