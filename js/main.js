// filename: js/main.js
/**
 * ============================================================================
 * main.js — 启动引导 + 初始化
 * ============================================================================
 *
 * 【本次重构】
 *   1. 折叠范围恢复增加校验（P1）：
 *      原实现直接 loadFromLocalStorage(FOLDED_RANGES, [])，
 *      未校验行号越界、块结构失效、数据篡改。
 *
 *      新流程：
 *        · 先加载原始折叠范围；
 *        · 用当前编辑器代码 split('\n') 得到 lines；
 *        · 调用 folding.js 的 validateFoldedRanges(lines, rawRanges)；
 *        · 用过滤后的合法范围替换 EditorState.foldedRanges；
 *        · 自增 foldedRangesVersion，使折叠行集合缓存正确失效。
 *
 *   2. 保留全部原有初始化步骤与顺序：
 *      HistoryManager / 回调注入 / IndexedDB / 设置加载 /
 *      文件名显示 / 折叠范围恢复 / 高亮开关 / stdin /
 *      内容恢复 / Worker / Shadow DOM / 查找替换恢复 /
 *      全量刷新 / 语言状态 / 后缀输入框 / 运行按钮 /
 *      事件绑定 / GBK 预热 / 聚焦。
 *
 *   3. 从 folding.js 的 import 中新增 validateFoldedRanges。
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
import { loadFromLocalStorage, saveToLocalStorage, escapeHtml } from './util.js';
import { HistoryManager, setHistoryManager } from './history.js';
import {
    openAutoSaveDatabase,
    saveCodeToIndexedDB
} from './storage.js';
import {
    setUpdateMatchCountCallback,
    setUpdateFileExtensionCallback,
    setEditorContent,
    fullUpdate,
    toggleClearButton,
    setOriginalCode,
    loadSavedCode,
    updateFileNameDisplay,
    updateUndoRedoState,
    updateRunButtonState
} from './editor-api.js';
import {
    setupShadowHighlightLayer,
    setHighlightScheduler,
    buildHighlightHTML,
    updateShadowHighlight,
    syncShadowScroll,
    findMatchingBracket,
    updateHighlightStatusIndicator,
    scheduleHighlightUpdate
} from './highlight.js';
import {
    createHighlightWorker,
    getMatchRangesAsync,
    updateMatchCountDebounced,
    bindReplaceModalEvents,
    restoreReplaceInputs
} from './search.js';
import {
    initializeEncodingSettings,
    bindEncodingSelectEvents
} from './encoding.js';
import { setupEditorEvents } from './editor.js';
import {
    setupLineNumberClickHandler,
    validateFoldedRanges
} from './folding.js';
import {
    bindImportEvents,
    bindDragAndDropEvents,
    bindDownloadEvents,
    initializeFileExtensionInput,
    updateFileExtensionForLanguage
} from './file-io.js';
import {
    bindOutputEvents,
    restoreStdinCache
} from './output.js';
import { bindRunButton } from './java-runner.js';
import {
    setupUIEvents,
    loadTheme,
    applyInitialFontSize,
    applyInitialWrap,
    loadIndentSetting,
    updateIndentIndicator
} from './ui.js';
import { setupSettingsIOEvents } from './settings-io.js';
import { bindDirectoryIOEvents } from './directory-io.js';
import { warmupGBKCodec } from './gbk-codec.js';

// ==================== Java 版本初始化 ====================

function initializeJavaVersion() {
    const savedVersion = loadFromLocalStorage(STORAGE_KEYS.JAVA_VERSION, '21.0.2');
    EditorState.javaVersion = savedVersion;
    DOM.javaVersionSelect.value = savedVersion;
}

function bindJavaVersionSelectEvent() {
    DOM.javaVersionSelect.addEventListener('change', function() {
        EditorState.javaVersion = this.value;
        saveToLocalStorage(STORAGE_KEYS.JAVA_VERSION, this.value);
        showToast('Java 版本已切换为 ' + this.value);
    });
}

// ==================== 高亮渲染调度器 ====================

/**
 * 由 main.js 注入到 highlight.js 的调度回调。
 * 回调负责：计算搜索/括号范围、调用 buildHighlightHTML 生成 HTML、
 *           更新 Shadow DOM 高亮层。
 *
 * TXT 为纯文本语义，不参与括号高亮。
 */
function performHighlightRender() {
    if (EditorState.largeFileActive) {
        if (EditorState.highlightPreElement) {
            EditorState.highlightPreElement.innerHTML = '';
        }
        syncShadowScroll();
        return;
    }

    if (!EditorState.highlightEnabled) {
        updateShadowHighlight(escapeHtml(DOM.codeEditor.value), EditorState.wordWrapEnabled);
        syncShadowScroll();
        return;
    }

    const bracketRanges = [];
    if (EditorState.currentLanguage !== 'txt') {
        const cursorPosition = DOM.codeEditor.selectionStart;
        if (cursorPosition > 0) {
            const checkPosition = cursorPosition - 1;
            if (DOM.codeEditor.value[checkPosition]
                && /[()\[\]{}]/.test(DOM.codeEditor.value[checkPosition])) {
                const matchingPos = findMatchingBracket(DOM.codeEditor.value, checkPosition);
                if (matchingPos !== -1) {
                    const rangeStart = Math.min(checkPosition, matchingPos);
                    const rangeEnd = Math.max(checkPosition, matchingPos) + 1;
                    bracketRanges.push({ start: rangeStart, end: rangeEnd });
                }
            }
        }
    }

    const currentLineIndex = DOM.codeEditor.value
        .substring(0, DOM.codeEditor.selectionStart)
        .split('\n').length - 1;

    if (DOM.replaceModalOverlay.classList.contains('open') && DOM.replaceFind.value) {
        getMatchRangesAsync(
            DOM.codeEditor.value,
            DOM.replaceFind.value,
            DOM.replaceCaseSensitive.checked,
            DOM.replaceWholeWord.checked,
            DOM.replaceUseRegex.checked,
            function(searchRanges, reason) {
                const finalHTML = buildHighlightHTML(
                    DOM.codeEditor.value,
                    EditorState.currentLanguage,
                    searchRanges,
                    bracketRanges,
                    currentLineIndex
                );
                updateShadowHighlight(finalHTML, EditorState.wordWrapEnabled);
                syncShadowScroll();
            },
            CONFIG.SEARCH_TIMEOUT_MS
        );
    } else {
        const finalHTML = buildHighlightHTML(
            DOM.codeEditor.value,
            EditorState.currentLanguage,
            [],
            bracketRanges,
            currentLineIndex
        );
        updateShadowHighlight(finalHTML, EditorState.wordWrapEnabled);
        syncShadowScroll();
    }
}

// ==================== 初始化 ====================

async function initialize() {
    // ---- 1. 历史管理器 ----
    const historyManagerInstance = new HistoryManager(CONFIG.MAX_HISTORY, {
        onStateApplied: function() {
            fullUpdate();
        },
        onButtonsUpdate: function() {
            updateUndoRedoState();
        }
    });
    setHistoryManager(historyManagerInstance);
    historyManagerInstance.pushState(DOM.codeEditor);

    // ---- 2. 注入循环依赖回调（匹配计数防抖） ----
    setUpdateMatchCountCallback(updateMatchCountDebounced);

    // ---- 2.1 注入后缀联动回调 ----
    setUpdateFileExtensionCallback(updateFileExtensionForLanguage);

    // ---- 3. 设置高亮调度器 ----
    setHighlightScheduler(performHighlightRender);

    // ---- 4. 打开 IndexedDB ----
    try {
        await openAutoSaveDatabase();
    } catch (dbError) {
        console.warn('IndexedDB 不可用，将仅使用 localStorage 缓存');
    }

    // ---- 5. 加载设置 ----
    loadIndentSetting();
    updateIndentIndicator();
    loadTheme();
    applyInitialFontSize();
    applyInitialWrap();
    initializeEncodingSettings();
    initializeJavaVersion();

    // ---- 6. 文件名显示 ----
    updateFileNameDisplay('在线代码编辑器');

    // ---- 7. 折叠范围恢复 + 校验 ----
    // 校验目的：避免历史折叠范围行号越界、块结构失效、数据篡改
    // 导致行号列渲染异常或折叠标记出现在错误位置。
    const rawFoldedRanges = loadFromLocalStorage(STORAGE_KEYS.FOLDED_RANGES, []);
    const currentLinesForFoldValidation = DOM.codeEditor.value.split('\n');
    EditorState.foldedRanges = validateFoldedRanges(
        currentLinesForFoldValidation,
        rawFoldedRanges
    );
    // 自增版本号，让折叠行集合缓存正确失效
    EditorState.foldedRangesVersion++;
    setupLineNumberClickHandler();

    // ---- 8. 高亮开关状态 ----
    EditorState.highlightEnabled = loadFromLocalStorage(STORAGE_KEYS.HIGHLIGHT_ENABLED, true);
    EditorState.userForcedHighlight = false;
    updateHighlightStatusIndicator(EditorState.highlightEnabled);

    // ---- 9. stdin 恢复 ----
    restoreStdinCache();

    // ---- 10. 恢复编辑内容 ----
    const wasRestored = await loadSavedCode();
    if (!wasRestored) {
        const savedLanguage = loadFromLocalStorage(STORAGE_KEYS.LANGUAGE, 'js');
        // 补传光标参数 (0, 0)，使初始光标位于文档开头。
        if (savedLanguage === 'java') {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.java, false, false, 0, 0);
        } else if (savedLanguage === 'python') {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.python, false, false, 0, 0);
        } else if (savedLanguage === 'html') {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.html, false, false, 0, 0);
        } else if (savedLanguage === 'css') {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.css, false, false, 0, 0);
        } else if (savedLanguage === 'txt') {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.txt, false, false, 0, 0);
        } else {
            setEditorContent(DEFAULT_CODE_BY_LANGUAGE.js, false, false, 0, 0);
        }
    }
    setOriginalCode(DOM.codeEditor.value);
    historyManagerInstance.pushState(DOM.codeEditor);

    // ---- 10.1 内容变化后再次校验折叠范围 ----
    // 恢复编辑内容后行数可能与初始不同，第二次校验保证折叠范围
    // 与最终实际内容严格一致。
    const restoredLinesForFoldValidation = DOM.codeEditor.value.split('\n');
    EditorState.foldedRanges = validateFoldedRanges(
        restoredLinesForFoldValidation,
        EditorState.foldedRanges
    );
    EditorState.foldedRangesVersion++;
    if (EditorState.foldedRanges.length !== rawFoldedRanges.length) {
        // 有失效项被过滤：把清理后的结果写回存储，避免下次启动重复过滤
        saveToLocalStorage(STORAGE_KEYS.FOLDED_RANGES, EditorState.foldedRanges);
    }

    // ---- 11. 创建搜索 Worker ----
    try {
        createHighlightWorker();
    } catch (workerError) {
        // createHighlightWorker 内部已做防御；此处仅兜底
        console.warn('Web Worker 创建失败，将使用主线程搜索', workerError);
    }

    // ---- 12. 初始化 Shadow DOM 高亮层 ----
    setupShadowHighlightLayer();

    // ---- 13. 恢复查找替换输入 ----
    restoreReplaceInputs();

    // ---- 14. 全量刷新 ----
    fullUpdate();
    toggleClearButton();

    // ---- 15. 恢复语言状态 ----
    const savedLanguage = loadFromLocalStorage(STORAGE_KEYS.LANGUAGE, 'js');
    EditorState.currentLanguage = savedLanguage;
    if (DOM.langSelect) {
        DOM.langSelect.value = savedLanguage;
    }
    DOM.langDisplay.textContent = LANGUAGE_DISPLAY_NAMES[savedLanguage] || savedLanguage;

    scheduleHighlightUpdate();

    // ---- 15.1 初始化后缀输入框 ----
    initializeFileExtensionInput();

    // ---- 16. 更新运行按钮状态 ----
    updateRunButtonState();

    // ---- 17. 保存初始内容到 IndexedDB ----
    try {
        await saveCodeToIndexedDB(DOM.codeEditor.value);
    } catch (saveError) {
        // 忽略
    }

    // ---- 18. 绑定所有事件 ----
    setupEditorEvents();
    bindReplaceModalEvents();
    bindEncodingSelectEvents();
    bindImportEvents();
    bindDragAndDropEvents();
    bindDownloadEvents();
    bindDirectoryIOEvents();
    bindOutputEvents();
    bindRunButton();
    bindJavaVersionSelectEvent();
    setupUIEvents();
    setupSettingsIOEvents();

    // ---- 19. 后台预热 GBK 映射表（不阻塞主流程） ----
    warmupGBKCodec();

    // ---- 20. 聚焦编辑器 ----
    DOM.codeEditor.focus();
    updateUndoRedoState();

    console.log(
        '%c🚀 专业版编辑器 v' + CONFIG.APP_VERSION + ' 已就绪',
        'color:#3fb950;font-weight:bold;'
    );
}

// ==================== 启动 ====================

initialize().catch(function(error) {
    console.error('初始化失败:', error);
    showToast('❌ 编辑器初始化失败，请刷新页面重试', true);
});