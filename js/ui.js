// filename: js/ui.js
/**
 * ============================================================================
 * ui.js — 主 UI 事件
 * ============================================================================
 *
 * 【本次重构】
 *   1. handleHighlightStatusClick 状态污染修复（P1）：
 *      原实现在用户取消大文件高亮 confirm 后，
 *      EditorState.userForcedHighlight 已被置为 true，
 *      但实际未开启高亮，造成状态与用户选择不一致。
 *
 *      新行为：
 *        · 先计算 newState；
 *        · 若需要 confirm 且用户取消 → 立即 return，
 *          不改 EditorState.userForcedHighlight；
 *        · 用户确认后才置位标志。
 *
 *   2. 自动保存状态颜色恢复：
 *      editor-api.js 的 triggerAutoSave 成功 2 秒后只改文字，
 *      不恢复颜色，导致状态栏长期绿色。
 *      本模块不直接负责该逻辑，由 editor-api.js 修复。
 *
 *   3. 缩进点击循环：保留原有 4→2→8→Tab 循环，
 *      但每次 Toast 明确显示"下一次会变成什么"，提升可预期性。
 *
 *   4. 保留全部原有导出接口与行为：
 *      setTheme / cycleTheme / loadTheme / setFontSize /
 *      applyInitialFontSize / toggleWordWrap / applyInitialWrap /
 *      updateIndentIndicator / loadIndentSetting / setupUIEvents。
 * ============================================================================
 */

import { EditorState } from './state.js';
import {
    STORAGE_KEYS,
    THEME_SEQUENCE
} from './config.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import {
    saveToLocalStorage,
    loadFromLocalStorage
} from './util.js';
import {
    handleUndo,
    handleRedo,
    updateUndoRedoState,
    saveImmediately,
    emergencySave,
    switchLanguage,
    setEditorContent,
    updateFileNameDisplay,
    fullUpdate
} from './editor-api.js';
import {
    syncShadowCSSVariables,
    scheduleHighlightUpdate,
    setHighlightEnabled,
    syncScroll
} from './highlight.js';
import { scrollToCursor, updateCursorPosition } from './line-numbers.js';
import { toggleReplaceModal, openReplaceModal } from './search.js';
import { runJavaCode } from './java-runner.js';
import { historyManager } from './history.js';

// ==================== 主题 ====================

/**
 * 应用主题。
 *
 * 主题图标由 CSS 通过 html[data-theme="..."] 属性切换：
 *   · dark   → #btnTheme 内的 .theme-icon-dark 显示（太阳）
 *   · light  → .theme-icon-light 显示（月亮）
 *   · ink    → .theme-icon-ink 显示（波浪）
 *   · cream  → .theme-icon-cream 显示（蛋糕）
 * JS 只需切换 documentElement 上的 data-theme 属性，无需操作图标内容。
 */
export function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    EditorState.theme = theme;
    saveToLocalStorage(STORAGE_KEYS.THEME, theme);
    DOM.btnTheme.setAttribute('aria-label', '切换主题（当前：' + theme + '）');
    syncShadowCSSVariables();
}

export function cycleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const currentIndex = THEME_SEQUENCE.indexOf(currentTheme);
    const nextTheme = THEME_SEQUENCE[(currentIndex + 1) % THEME_SEQUENCE.length];
    setTheme(nextTheme);
    showToast('主题已切换为 ' + nextTheme);
}

export function loadTheme() {
    const savedTheme = loadFromLocalStorage(STORAGE_KEYS.THEME, 'dark');
    setTheme(savedTheme);
}

// ==================== 字体缩放 ====================

export function setFontSize(size) {
    EditorState.currentFontSize = Math.max(10, Math.min(30, size));
    document.documentElement.style.setProperty('--editor-font-size', EditorState.currentFontSize + 'px');
    saveToLocalStorage(STORAGE_KEYS.FONT_SIZE, EditorState.currentFontSize);
    syncShadowCSSVariables();
}

export function applyInitialFontSize() {
    const savedSize = loadFromLocalStorage(STORAGE_KEYS.FONT_SIZE, 14);
    EditorState.currentFontSize = savedSize;
    document.documentElement.style.setProperty('--editor-font-size', savedSize + 'px');
    syncShadowCSSVariables();
}

// ==================== 自动换行 ====================

export function toggleWordWrap() {
    EditorState.wordWrapEnabled = !EditorState.wordWrapEnabled;
    if (EditorState.wordWrapEnabled) {
        DOM.codeEditor.wrap = 'soft';
        DOM.btnWrap.style.color = 'var(--accent)';
    } else {
        DOM.codeEditor.wrap = 'off';
        DOM.btnWrap.style.color = '';
    }
    saveToLocalStorage(STORAGE_KEYS.WRAP_ENABLED, EditorState.wordWrapEnabled);
    scheduleHighlightUpdate();
    showToast(EditorState.wordWrapEnabled ? '自动换行：开' : '自动换行：关');
}

export function applyInitialWrap() {
    const savedWrap = loadFromLocalStorage(STORAGE_KEYS.WRAP_ENABLED, false);
    EditorState.wordWrapEnabled = savedWrap;
    DOM.codeEditor.wrap = savedWrap ? 'soft' : 'off';
    if (savedWrap) DOM.btnWrap.style.color = 'var(--accent)';
}

// ==================== 缩进设置 ====================

export function updateIndentIndicator() {
    if (EditorState.indentCharacter === '\t') {
        DOM.indentIndicator.textContent = 'Tab';
    } else {
        DOM.indentIndicator.textContent = EditorState.indentSize + ' 空格';
    }
    saveToLocalStorage(STORAGE_KEYS.INDENT, {
        size: EditorState.indentSize,
        character: EditorState.indentCharacter
    });
}

export function loadIndentSetting() {
    const savedIndent = loadFromLocalStorage(STORAGE_KEYS.INDENT, { size: 4, character: ' ' });
    EditorState.indentSize = savedIndent.size;
    EditorState.indentCharacter = savedIndent.character;
}

/**
 * 循环切换缩进设置。
 *
 * 顺序：4 空格 → 2 空格 → 8 空格 → Tab → 4 空格 → ...
 *
 * Toast 中不仅显示"当前"，也显示"下一次点击会变成什么"，
 * 弥补点击循环不可预期的问题。
 */
function cycleIndent() {
    let nextIndentDisplay = '';

    if (EditorState.indentCharacter === ' ' && EditorState.indentSize === 4) {
        EditorState.indentSize = 2;
        EditorState.indentCharacter = ' ';
        nextIndentDisplay = '8 空格';
    } else if (EditorState.indentCharacter === ' ' && EditorState.indentSize === 2) {
        EditorState.indentSize = 8;
        EditorState.indentCharacter = ' ';
        nextIndentDisplay = 'Tab';
    } else if (EditorState.indentCharacter === ' ' && EditorState.indentSize === 8) {
        EditorState.indentCharacter = '\t';
        nextIndentDisplay = '4 空格';
    } else {
        EditorState.indentCharacter = ' ';
        EditorState.indentSize = 4;
        nextIndentDisplay = '2 空格';
    }
    updateIndentIndicator();
    const indentDisplay = EditorState.indentCharacter === '\t'
        ? 'Tab'
        : EditorState.indentSize + ' 空格';
    showToast('缩进已切换为 ' + indentDisplay + '（下次点击：' + nextIndentDisplay + '）');
}

// ==================== 复制 ====================

async function copyCode() {
    const currentCode = DOM.codeEditor.value;
    if (!currentCode.trim()) {
        showToast('⚠️ 编辑器为空，请先输入代码', true);
        return;
    }
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(currentCode);
        } else {
            const tempTextarea = document.createElement('textarea');
            tempTextarea.value = currentCode;
            tempTextarea.style.position = 'fixed';
            tempTextarea.style.left = '-9999px';
            document.body.appendChild(tempTextarea);
            tempTextarea.select();
            document.execCommand('copy');
            document.body.removeChild(tempTextarea);
        }
        DOM.copyIcon.style.display = 'none';
        DOM.checkIcon.style.display = 'inline-block';
        DOM.copyText.textContent = '已复制';
        DOM.btnCopy.style.background = 'var(--green-bg)';
        DOM.btnCopy.style.color = 'var(--green)';
        DOM.btnCopy.style.borderColor = 'var(--green)';
        showToast('✅ 代码已复制到剪贴板');
        if (EditorState.copyRestoreTimer) clearTimeout(EditorState.copyRestoreTimer);
        EditorState.copyRestoreTimer = setTimeout(function() {
            DOM.checkIcon.style.display = 'none';
            DOM.copyIcon.style.display = 'inline-block';
            DOM.copyText.textContent = '复制';
            DOM.btnCopy.style.background = '';
            DOM.btnCopy.style.color = '';
            DOM.btnCopy.style.borderColor = '';
            EditorState.copyRestoreTimer = null;
        }, 2000);
    } catch (copyError) {
        showToast('❌ 复制失败，请手动选择复制', true);
    }
}

// ==================== 清空 / 全选 ====================

function clearEditor() {
    if (!DOM.codeEditor.value.trim()) {
        showToast('编辑器已为空');
        return;
    }
    if (!confirm('确定要清空编辑器中的所有代码吗？')) return;
    setEditorContent('', true);
    updateFileNameDisplay('在线代码编辑器');
    showToast('🗑️ 编辑器已清空');
}

function selectAll() {
    DOM.codeEditor.focus();
    DOM.codeEditor.select();
    updateCursorPosition();
}

// ==================== 高亮状态点击 ====================

/**
 * 处理高亮状态点击。
 *
 * 修复状态污染：
 *   · 用户在大文件 confirm 中取消 → 立即 return，
 *     不改 EditorState.userForcedHighlight；
 *   · 用户确认后才置位 userForcedHighlight = true。
 */
function handleHighlightStatusClick() {
    const newState = !EditorState.highlightEnabled;

    // 大文件开启高亮：先 confirm，再改状态
    if (newState && EditorState.largeFileActive) {
        if (!confirm('大文件开启高亮可能导致编辑器卡顿，确定继续？')) {
            // 用户取消：完全无副作用，状态与标志均保持原样
            return;
        }
        EditorState.userForcedHighlight = true;
        EditorState.largeFileActive = false;
        if (historyManager) historyManager.setLargeFileMode(false);
        setHighlightEnabled(newState, false);
        fullUpdate();
        showToast('高亮已开启');
        return;
    }

    // 普通情况：直接切换
    EditorState.userForcedHighlight = newState;
    setHighlightEnabled(newState, false);
    showToast(newState ? '高亮已开启' : '高亮已关闭');
}

// ==================== 大文件弹窗 ====================

function bindLargeFileModalEvents() {
    DOM.btnEnableHighlightModal.addEventListener('click', function() {
        EditorState.userForcedHighlight = true;
        EditorState.largeFileActive = false;
        if (historyManager) historyManager.setLargeFileMode(false);
        setHighlightEnabled(true, false);
        DOM.largeFileModal.classList.remove('open');
        fullUpdate();
        showToast('已手动开启高亮，编辑大型文件时请注意性能');
    });

    DOM.btnDismissLargeFileModal.addEventListener('click', function() {
        DOM.largeFileModal.classList.remove('open');
        EditorState.userForcedHighlight = true;
    });

    DOM.largeFileModal.addEventListener('click', function(event) {
        if (event.target === DOM.largeFileModal) DOM.largeFileModal.classList.remove('open');
    });
}

// ==================== 帮助弹窗 ====================

function bindHelpModalEvents() {
    DOM.btnHelp.addEventListener('click', function() {
        EditorState.lastFocusedElement = document.activeElement;
        DOM.helpModal.classList.add('open');
        DOM.btnCloseHelp.focus();
    });

    DOM.btnCloseHelp.addEventListener('click', function() {
        DOM.helpModal.classList.remove('open');
        if (EditorState.lastFocusedElement) EditorState.lastFocusedElement.focus();
    });

    DOM.helpModal.addEventListener('click', function(event) {
        if (event.target === DOM.helpModal) {
            DOM.helpModal.classList.remove('open');
            if (EditorState.lastFocusedElement) EditorState.lastFocusedElement.focus();
        }
    });

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && DOM.helpModal.classList.contains('open')) {
            DOM.helpModal.classList.remove('open');
            if (EditorState.lastFocusedElement) EditorState.lastFocusedElement.focus();
        }
    });
}

// ==================== 全局快捷键 ====================

function isEditableInputFocused() {
    const activeElement = document.activeElement;
    if (!activeElement) return false;
    if (activeElement === DOM.codeEditor) return false;
    const tagName = activeElement.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || activeElement.isContentEditable) return true;
    return false;
}

function handleGlobalKeyDown(event) {
    const isCtrlOrMeta = event.ctrlKey || event.metaKey;

    if (isCtrlOrMeta && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setFontSize(EditorState.currentFontSize + 1);
        showToast('字体大小: ' + EditorState.currentFontSize + 'px');
        return;
    }
    if (isCtrlOrMeta && event.key === '-') {
        event.preventDefault();
        setFontSize(EditorState.currentFontSize - 1);
        showToast('字体大小: ' + EditorState.currentFontSize + 'px');
        return;
    }
    if (isCtrlOrMeta && event.key === '0') {
        event.preventDefault();
        setFontSize(14);
        showToast('字体已重置为 14px');
        return;
    }
    if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        if (!DOM.replaceModalOverlay.classList.contains('open')) openReplaceModal();
        DOM.replaceFind.focus();
        return;
    }
    if (isCtrlOrMeta && event.key === 'h') {
        event.preventDefault();
        if (!DOM.replaceModalOverlay.classList.contains('open')) openReplaceModal();
        DOM.replaceWith.focus();
        return;
    }
    if (isCtrlOrMeta && event.key === 'g') {
        event.preventDefault();
        const lineInput = prompt('跳转到行号:');
        if (lineInput && !isNaN(lineInput)) {
            const allLines = DOM.codeEditor.value.split('\n');
            const targetLine = Math.min(Math.max(1, parseInt(lineInput)), allLines.length);
            let characterPosition = 0;
            for (let j = 0; j < targetLine - 1; j++) {
                characterPosition += allLines[j].length + 1;
            }
            DOM.codeEditor.focus();
            DOM.codeEditor.setSelectionRange(characterPosition, characterPosition);
            scrollToCursor();
            updateCursorPosition();
            showToast('已跳转到第 ' + targetLine + ' 行');
        }
        return;
    }
    if (isCtrlOrMeta && event.key === 's') {
        event.preventDefault();
        saveImmediately().catch(function() { /* 静默 */ });
        return;
    }
    if (isCtrlOrMeta && event.key === 'z' && !event.shiftKey && !isEditableInputFocused()) {
        event.preventDefault();
        handleUndo();
        updateUndoRedoState();
        scrollToCursor();
        return;
    }
    if (isCtrlOrMeta && (event.key === 'y' || (event.key === 'z' && event.shiftKey)) && !isEditableInputFocused()) {
        event.preventDefault();
        handleRedo();
        updateUndoRedoState();
        scrollToCursor();
        return;
    }
    if (isCtrlOrMeta && event.key === 't') {
        event.preventDefault();
        cycleTheme();
        showToast('主题: ' + EditorState.theme);
        return;
    }
    // ---- Ctrl+Enter：仅 Java 语言时消耗事件 ----
    if (isCtrlOrMeta && event.key === 'Enter') {
        if (EditorState.currentLanguage === 'java') {
            event.preventDefault();
            runJavaCode();
            return;
        }
    }
    if (isEditableInputFocused()) return;
    if (isCtrlOrMeta && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
        event.preventDefault();
        copyCode();
        return;
    }
}

// ==================== 页面生命周期 ====================

function bindPageLifecycleEvents() {
    window.addEventListener('pagehide', emergencySave);
    window.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') emergencySave();
    });
    window.addEventListener('beforeunload', function(event) {
        if (EditorState.highlightWorker) {
            EditorState.highlightWorker.terminate();
            EditorState.highlightWorker = null;
        }
        emergencySave();

        // skipBeforeUnload 双字段判定：
        //   标志为 true 且未过期 → 直接放行
        //   已过期或标志为 false → 重置双字段并走常规未保存检查路径
        if (EditorState.skipBeforeUnload) {
            const isSkipFlagStillValid = EditorState.skipBeforeUnloadExpiresAt > Date.now();
            if (isSkipFlagStillValid) {
                return;
            }
            EditorState.skipBeforeUnload = false;
            EditorState.skipBeforeUnloadExpiresAt = 0;
        }

        if (EditorState.codeModified) {
            event.preventDefault();
            event.returnValue = '您有未保存的更改，刷新页面可能会丢失。';
            return event.returnValue;
        }
    });
    window.addEventListener('resize', function() {
        syncScroll();
    });
}

// ==================== 智能 textarea 高度 ====================

function initializeResizableTextareas() {
    const resizeHandles = document.querySelectorAll('.resize-handle-textarea');
    const textareaHeightStorageKeys = {
        replaceFind: STORAGE_KEYS.REPLACE_FIND_MANUAL_HEIGHT,
        replaceWith: STORAGE_KEYS.REPLACE_WITH_MANUAL_HEIGHT
    };

    function restoreTextareaHeight(textareaId) {
        const textareaElement = document.getElementById(textareaId);
        if (!textareaElement) return;
        const savedHeight = loadFromLocalStorage(textareaHeightStorageKeys[textareaId], null);
        if (savedHeight && typeof savedHeight === 'number' && savedHeight >= 60 && savedHeight <= 400) {
            textareaElement.style.height = savedHeight + 'px';
        } else {
            textareaElement.style.height = '60px';
        }
        textareaElement.style.resize = 'none';
    }

    restoreTextareaHeight('replaceFind');
    restoreTextareaHeight('replaceWith');

    resizeHandles.forEach(function(handle) {
        const targetId = handle.getAttribute('data-target');
        const targetTextarea = document.getElementById(targetId);
        if (!targetTextarea) return;

        let isDraggingHeight = false;
        let dragStartY = 0;
        let dragStartHeight = 0;

        const onMouseMoveResize = function(moveEvent) {
            if (!isDraggingHeight) return;
            const deltaY = moveEvent.clientY - dragStartY;
            let newHeight = dragStartHeight + deltaY;
            newHeight = Math.min(400, Math.max(60, newHeight));
            targetTextarea.style.height = newHeight + 'px';
        };

        const onMouseUpResize = function() {
            if (!isDraggingHeight) return;
            isDraggingHeight = false;
            document.removeEventListener('mousemove', onMouseMoveResize);
            document.removeEventListener('mouseup', onMouseUpResize);
            const finalHeight = targetTextarea.offsetHeight;
            saveToLocalStorage(textareaHeightStorageKeys[targetId], finalHeight);
        };

        handle.addEventListener('mousedown', function(downEvent) {
            downEvent.preventDefault();
            downEvent.stopPropagation();
            isDraggingHeight = true;
            dragStartY = downEvent.clientY;
            dragStartHeight = targetTextarea.offsetHeight;
            document.addEventListener('mousemove', onMouseMoveResize);
            document.addEventListener('mouseup', onMouseUpResize);
        });
    });
}

// ==================== 事件绑定入口 ====================

export function setupUIEvents() {
    DOM.btnTheme.addEventListener('click', cycleTheme);
    DOM.btnWrap.addEventListener('click', toggleWordWrap);
    DOM.indentIndicator.addEventListener('click', cycleIndent);
    DOM.highlightStatus.addEventListener('click', handleHighlightStatusClick);
    DOM.btnCopy.addEventListener('click', copyCode);
    DOM.btnClear.addEventListener('click', clearEditor);
    DOM.btnSelectAll.addEventListener('click', selectAll);
    DOM.btnUndo.addEventListener('click', function() {
        handleUndo();
        updateUndoRedoState();
    });
    DOM.btnRedo.addEventListener('click', function() {
        handleRedo();
        updateUndoRedoState();
    });
    DOM.btnToggleReplace.addEventListener('click', toggleReplaceModal);

    if (DOM.langSelect) {
        DOM.langSelect.addEventListener('change', function() {
            switchLanguage(this.value);
        });
    }

    document.addEventListener('keydown', handleGlobalKeyDown);
    bindHelpModalEvents();
    bindLargeFileModalEvents();
    bindPageLifecycleEvents();
    initializeResizableTextareas();

    DOM.codeEditor.addEventListener('input', updateUndoRedoState);
    DOM.codeEditor.addEventListener('keyup', updateUndoRedoState);
}