// filename: js/editor.js
/**
 * ============================================================================
 * editor.js — 编辑器核心（键盘输入、光标、缩进、括号匹配、粘贴、滚动）
 * ============================================================================
 *
 * 【本次更新】
 *   1. 修复 A1（普通键盘输入无法撤销）：
 *      handleEditorInput 增加 250ms 防抖 pushState。
 *
 *   2. TXT 模式 Ctrl+/ 增加 Toast 提示：
 *      原实现仅 preventDefault 后静默 return，用户无法判断是快捷键失灵
 *      还是语义上不支持。现改为明确提示，避免困惑。
 *
 * 【保留】
 *   v8.5.3 Ctrl+↑ / Ctrl+Shift+↑ 分支；
 *   v8.5.3 TXT 禁用自动配对；
 *   v8.5.1 TXT 禁用智能缩进与 Ctrl+/ 注释。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { DOM } from './dom.js';
import { historyManager } from './history.js';
import {
    setEditorContent,
    fullUpdate,
    triggerAutoSave,
    debouncedUpdate,
    toggleClearButton,
    updateUndoRedoState
} from './editor-api.js';
import { updateCursorPosition } from './line-numbers.js';
import { syncScroll } from './highlight.js';
import { showToast } from './toast.js';
import { escapeRegExp } from './util.js';

// ==================== 普通键盘输入的历史快照防抖 ====================

// 打字历史快照的防抖时长（毫秒）。
// 连续按键在此期间内会被合并为一次 pushState。
const TYPING_HISTORY_DEBOUNCE_MS = 250;

// ==================== 工具函数 ====================

export function getIndentString() {
    if (EditorState.indentCharacter === '\t') return '\t';
    return ' '.repeat(EditorState.indentSize);
}

export function isInsideStringOrComment(code, position) {
    if (EditorState.largeFileActive) return false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < position; i++) {
        const character = code[i];
        if (inLineComment) {
            if (character === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (character === '*' && code[i + 1] === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inSingleQuote && character === '\\') { i++; continue; }
        if (inDoubleQuote && character === '\\') { i++; continue; }
        if (inBacktick && character === '\\') { i++; continue; }

        if (character === "'" && !inDoubleQuote && !inBacktick) inSingleQuote = !inSingleQuote;
        else if (character === '"' && !inSingleQuote && !inBacktick) inDoubleQuote = !inDoubleQuote;
        else if (character === '`' && !inSingleQuote && !inDoubleQuote) inBacktick = !inBacktick;
        else if (!inSingleQuote && !inDoubleQuote && !inBacktick && character === '/' && code[i + 1] === '/') {
            inLineComment = true;
            i++;
        } else if (!inSingleQuote && !inDoubleQuote && !inBacktick && character === '/' && code[i + 1] === '*') {
            inBlockComment = true;
            i++;
        }
    }
    return inSingleQuote || inDoubleQuote || inBacktick || inLineComment || inBlockComment;
}

// ==================== 主键盘处理器 ====================

function handleEditorKeyDown(event) {
    if (EditorState.largeFileActive) return;
    const openingPairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    const closingPairs = { ')': '(', ']': '[', '}': '{' };
    const pressedKey = event.key;
    const selectionStart = this.selectionStart;
    const selectionEnd = this.selectionEnd;
    const editorValue = this.value;

    // ---- Ctrl + ↑ / Ctrl + Shift + ↑ ----
    if ((event.ctrlKey || event.metaKey) && pressedKey === 'ArrowUp') {
        event.preventDefault();
        if (event.shiftKey) {
            const anchorPosition = (selectionStart === selectionEnd)
                ? selectionStart
                : Math.max(selectionStart, selectionEnd);
            if (anchorPosition > 0) {
                this.setSelectionRange(0, anchorPosition);
            }
        } else {
            this.selectionStart = this.selectionEnd = 0;
        }
        this.scrollTop = 0;
        syncScroll();
        updateCursorPosition();
        return;
    }

    // ---- 跳过已存在的闭合符号 ----
    if (pressedKey in closingPairs && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (selectionStart === selectionEnd && editorValue[selectionStart] === pressedKey) {
            event.preventDefault();
            this.selectionStart = this.selectionEnd = selectionStart + 1;
            updateCursorPosition();
            return;
        }
    }

    // ---- 自动配对 ----
    if (pressedKey in openingPairs && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        // TXT 为纯文本语义，禁用自动配对。
        if (EditorState.currentLanguage === 'txt') return;

        // 选中区被包裹分支
        if (selectionStart !== selectionEnd) {
            event.preventDefault();
            const selectedText = editorValue.substring(selectionStart, selectionEnd);
            const replacement = pressedKey + selectedText + openingPairs[pressedKey];
            if (historyManager) historyManager.pushState(DOM.codeEditor);

            EditorState.internalEditorUpdate = true;
            try {
                this.setRangeText(replacement, selectionStart, selectionEnd, 'select');
            } finally {
                EditorState.internalEditorUpdate = false;
            }

            if (historyManager) historyManager.pushState(DOM.codeEditor);
            fullUpdate();
            triggerAutoSave();
            toggleClearButton();
            return;
        }

        // 未选中内容，插入成对括号分支
        if (isInsideStringOrComment(editorValue, selectionStart)) return;
        const nextCharacter = editorValue[selectionStart];
        if (nextCharacter === '' || /[\s}\]\)]/.test(nextCharacter)) {
            event.preventDefault();
            if (historyManager) historyManager.pushState(DOM.codeEditor);

            EditorState.internalEditorUpdate = true;
            try {
                this.setRangeText(pressedKey + openingPairs[pressedKey], selectionStart, selectionStart, 'start');
            } finally {
                EditorState.internalEditorUpdate = false;
            }

            this.selectionStart = this.selectionEnd = selectionStart + 1;
            if (historyManager) historyManager.pushState(DOM.codeEditor);
            fullUpdate();
            triggerAutoSave();
            toggleClearButton();
        }
        return;
    }

    // ---- Enter 智能缩进 ----
    if (pressedKey === 'Enter') {
        event.preventDefault();
        const textBeforeCursor = editorValue.substring(0, selectionStart);
        const textAfterCursor = editorValue.substring(selectionEnd);
        const currentLineStart = editorValue.lastIndexOf('\n', selectionStart - 1) + 1;
        const currentLine = editorValue.substring(currentLineStart, selectionStart);
        const currentIndent = currentLine.match(/^[ \t]*/)[0];
        const trimmedLine = currentLine.trimEnd();
        let extraIndent = '';

        // TXT 为纯文本语义，不根据 { ( [ : 结尾自动追加缩进。
        if (
            EditorState.currentLanguage !== 'txt' &&
            !isInsideStringOrComment(editorValue, selectionStart)
        ) {
            if (
                trimmedLine.endsWith('{') ||
                trimmedLine.endsWith('(') ||
                trimmedLine.endsWith('[') ||
                (EditorState.currentLanguage === 'python' && trimmedLine.endsWith(':'))
            ) {
                extraIndent = getIndentString();
            }
        }

        const insertedText = '\n' + currentIndent + extraIndent;
        const newValue = textBeforeCursor + insertedText + textAfterCursor;
        const newCursorPos = selectionStart + insertedText.length;
        setEditorContent(newValue, true, false, newCursorPos, newCursorPos);
        return;
    }

    // ---- Backspace 智能删除整级缩进 ----
    if (pressedKey === 'Backspace') {
        const lineStart = editorValue.lastIndexOf('\n', selectionStart - 1) + 1;
        const lineContent = editorValue.substring(lineStart, selectionStart);
        if (selectionStart === selectionEnd && lineContent.trim() === '' && lineContent.length > 0) {
            const currentLineIndent = lineContent.match(/^[ \t]*/)[0];
            const removeLength = (EditorState.indentCharacter === '\t') ? 1 : EditorState.indentSize;
            if (currentLineIndent.length >= removeLength && (selectionStart - lineStart) <= currentLineIndent.length) {
                event.preventDefault();
                const newIndent = currentLineIndent.substring(removeLength);
                const newValue = editorValue.substring(0, lineStart) + newIndent + editorValue.substring(selectionStart);
                const newCursorPos = lineStart + newIndent.length;
                setEditorContent(newValue, true, false, newCursorPos, newCursorPos);
                return;
            }
        }
    }

    // ---- Tab 缩进 ----
    if (pressedKey === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        const indentStr = getIndentString();

        if (selectionStart !== selectionEnd) {
            const textBeforeSelection = editorValue.substring(0, selectionStart);
            const selectedText = editorValue.substring(selectionStart, selectionEnd);
            const textAfterSelection = editorValue.substring(selectionEnd);
            const selectedLines = selectedText.split('\n');
            const indentedLines = selectedLines.map(function(line) {
                return indentStr + line;
            }).join('\n');
            const newValue = textBeforeSelection + indentedLines + textAfterSelection;
            const newCursorStart = selectionStart;
            const newCursorEnd = selectionStart + indentedLines.length;
            setEditorContent(newValue, true, false, newCursorStart, newCursorEnd);
        } else {
            if (historyManager) historyManager.pushState(DOM.codeEditor);
            EditorState.internalEditorUpdate = true;
            try {
                this.setRangeText(indentStr, selectionStart, selectionStart, 'end');
            } finally {
                EditorState.internalEditorUpdate = false;
            }
            if (historyManager) historyManager.pushState(DOM.codeEditor);
            fullUpdate();
            triggerAutoSave();
            toggleClearButton();
        }
        return;
    }

    // ---- Shift + Tab 反缩进 ----
    if (pressedKey === 'Tab' && event.shiftKey) {
        event.preventDefault();
        if (selectionStart !== selectionEnd) {
            const textBeforeSelection = editorValue.substring(0, selectionStart);
            const selectedText = editorValue.substring(selectionStart, selectionEnd);
            const textAfterSelection = editorValue.substring(selectionEnd);
            const selectedLines = selectedText.split('\n');
            const removePattern = (EditorState.indentCharacter === '\t')
                ? '\t'
                : ' {1,' + EditorState.indentSize + '}';
            const dedentedLines = selectedLines.map(function(line) {
                return line.replace(new RegExp('^' + removePattern), '');
            });
            const newValue = textBeforeSelection + dedentedLines.join('\n') + textAfterSelection;
            const newCursorStart = selectionStart;
            const newCursorEnd = selectionStart + dedentedLines.join('\n').length;
            setEditorContent(newValue, true, false, newCursorStart, newCursorEnd);
        } else {
            const lineStart = editorValue.lastIndexOf('\n', selectionStart - 1) + 1;
            const lineContent = editorValue.substring(lineStart, selectionStart);
            const removePattern = (EditorState.indentCharacter === '\t')
                ? '^\t'
                : '^ {1,' + EditorState.indentSize + '}';
            const indentMatch = lineContent.match(new RegExp(removePattern));
            if (indentMatch && selectionStart - lineStart <= indentMatch[0].length) {
                const newValue = editorValue.substring(0, lineStart)
                    + lineContent.substring(indentMatch[0].length)
                    + editorValue.substring(selectionStart);
                const newCursorPos = selectionStart - indentMatch[0].length;
                setEditorContent(newValue, true, false, newCursorPos, newCursorPos);
            }
        }
        return;
    }
}

// ==================== 注释切换 ====================

function handleCommentToggle(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== '/') return;
    event.preventDefault();

    if (EditorState.largeFileActive) {
        showToast('⚠️ 大文件模式下注释功能受限', true);
        return;
    }
    // TXT 为纯文本语义，无注释概念。
    // 给出 Toast 提示而不是静默 return —— 避免用户以为快捷键失灵。
    // （event.preventDefault() 已调用，浏览器不会插入 '/' 字符。）
    if (EditorState.currentLanguage === 'txt') {
        showToast('ℹ️ TXT 模式无注释功能');
        return;
    }

    const selectionStart = this.selectionStart;
    const selectionEnd = this.selectionEnd;
    const editorValue = this.value;
    const textBeforeSelection = editorValue.substring(0, selectionStart);
    const selectedText = editorValue.substring(selectionStart, selectionEnd);
    const textAfterSelection = editorValue.substring(selectionEnd);

    let commentCharacter = '//';
    if (EditorState.currentLanguage === 'python') commentCharacter = '#';
    else if (EditorState.currentLanguage === 'html') commentCharacter = '<!-- -->';
    else if (EditorState.currentLanguage === 'css') commentCharacter = '/* */';
    else if (EditorState.currentLanguage === 'java') commentCharacter = '//';

    let newSelection;
    if (EditorState.currentLanguage === 'html') {
        const isCommented = selectedText.startsWith('<!--') && selectedText.endsWith('-->');
        newSelection = isCommented ? selectedText.slice(5, -4) : '<!--' + selectedText + '-->';
    } else if (EditorState.currentLanguage === 'css') {
        const isCommented = selectedText.startsWith('/*') && selectedText.endsWith('*/');
        newSelection = isCommented ? selectedText.slice(2, -2) : '/*' + selectedText + '*/';
    } else {
        const selectedLines = selectedText.split('\n');
        const allLinesCommented = selectedLines.every(function(line) {
            return line.trimStart().startsWith(commentCharacter);
        });
        if (allLinesCommented) {
            newSelection = selectedLines.map(function(line) {
                return line.replace(new RegExp('^\\s*' + escapeRegExp(commentCharacter) + '\\s?'), '');
            }).join('\n');
        } else {
            newSelection = selectedLines.map(function(line) {
                return commentCharacter + ' ' + line;
            }).join('\n');
        }
    }

    const newValue = textBeforeSelection + newSelection + textAfterSelection;
    const newCursorStart = selectionStart;
    const newCursorEnd = selectionStart + newSelection.length;
    setEditorContent(newValue, true, false, newCursorStart, newCursorEnd);
}

// ==================== 粘贴处理 ====================

function handleEditorPaste(event) {
    event.preventDefault();
    const clipboardData = event.clipboardData || window.clipboardData;
    const pastedText = clipboardData.getData('text/plain');
    if (pastedText.length > EditorState.maxPasteSize) {
        showToast('❌ 粘贴内容超过 1.5MB，已阻止粘贴以避免卡顿', true);
        return;
    }
    const start = this.selectionStart;
    const end = this.selectionEnd;
    const newValue = this.value.substring(0, start) + pastedText + this.value.substring(end);
    if (newValue.length > EditorState.absoluteFileSizeLimit) {
        showToast('❌ 粘贴后内容超过 2MB，已阻止粘贴', true);
        return;
    }
    const newCursorPos = start + pastedText.length;
    setEditorContent(newValue, true, false, newCursorPos, newCursorPos);
}

// ==================== 输入事件 ====================

function handleEditorInput() {
    // 内部驱动的更新直接返回，避免与显式 fullUpdate 叠加。
    if (EditorState.internalEditorUpdate) return;

    debouncedUpdate();
    toggleClearButton();
    triggerAutoSave();

    // ---- 普通键盘输入的历史快照（修复 A1） ----
    // 连续按键在 TYPING_HISTORY_DEBOUNCE_MS 内被合并为一次 pushState。
    // Ctrl+Z / 撤销按钮通过 editor-api.js 的 flushPendingHistoryIfNeeded
    // 在撤销前强制落盘，保证"输入后立刻撤销"有效。
    if (EditorState.typingHistoryDebounceTimer !== null) {
        clearTimeout(EditorState.typingHistoryDebounceTimer);
    }
    EditorState.typingHistoryDebounceTimer = setTimeout(function() {
        EditorState.typingHistoryDebounceTimer = null;
        if (historyManager) {
            historyManager.pushState(DOM.codeEditor);
        }
        updateUndoRedoState();
    }, TYPING_HISTORY_DEBOUNCE_MS);

    // 打字期间撤销按钮应立即可用（内容已变化）
    updateUndoRedoState();

    if (DOM.replaceModalOverlay.classList.contains('open')) {
        EditorState.lastSearchMatches = [];
        EditorState.searchMatchIndex = -1;
    }
}

// ==================== 绑定入口 ====================

export function setupEditorEvents() {
    DOM.codeEditor.addEventListener('keydown', handleEditorKeyDown);
    DOM.codeEditor.addEventListener('keydown', handleCommentToggle);
    DOM.codeEditor.addEventListener('click', updateCursorPosition);
    DOM.codeEditor.addEventListener('keyup', updateCursorPosition);
    DOM.codeEditor.addEventListener('input', handleEditorInput);
    DOM.codeEditor.addEventListener('paste', handleEditorPaste);
    DOM.codeEditor.addEventListener('scroll', syncScroll, { passive: true });
}