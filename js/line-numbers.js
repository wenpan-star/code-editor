// filename: js/line-numbers.js
/**
 * ============================================================================
 * line-numbers.js — 行号渲染 + 光标位置 + 滚动定位
 * ============================================================================
 *
 * 【本次更新】
 *   修复折叠隐藏行的高度塌缩（P0）：
 *
 *   原实现在折叠隐藏行渲染占位容器时，第二个 span 是空的：
 *       html += '<span></span>';
 *   由于 .line-numbers span 使用 display: block 但未显式设置高度，
 *   空内容的 block 元素高度为 0 → 折叠隐藏行在行号列中占据 0 像素 →
 *   折叠块之后的全部行号向上漂移（累积误差随折叠行数增长）。
 *
 *   修复方式：在空 span 中注入一个零宽空格（U+200B）。
 *     · 零宽字符在所有主流浏览器的文本布局引擎中都会占据一个行高
 *       （由 line-height 决定），但宽度为 0，不影响行号列的右对齐。
 *     · 已设置 aria-hidden="true"，辅助技术不会朗读该字符。
 *     · 相比之下 '&nbsp;' 会占据一个字符宽度，右侧 padding 计算略受影响；
 *       零宽空格是更干净的选择。
 *
 * 【保留】
 *   · renderLineNumbersWithFolds 支持接收已 split 的 lines 数组，
 *     避免在 updateLineNumbers 与 renderLineNumbersWithFolds 中重复 split。
 *   · 折叠标记判定使用缓存的 getFoldedLinesSet（O(1) Set 查询）。
 *   · scrollToCursor 读取实际 CSS 行高而非硬编码。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { DOM } from './dom.js';
import { findFoldRange, getFoldedLinesSet } from './folding.js';
import { syncShadowScroll } from './highlight.js';

// 零宽空格字符（U+200B）：
//   · 不占宽度；
//   · 在文本布局中占据一个行高（由 CSS line-height 决定）；
//   · 用于撑开折叠占位容器的高度，使其与普通行严格等高。
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * 渲染带折叠标记的行号列。
 *
 * @param {string[]} [lines] 预先 split 的行数组（可选）。
 *                           传入时避免重复 split；不传时内部自行 split。
 */
export function renderLineNumbersWithFolds(lines) {
    if (EditorState.largeFileActive) return;

    const linesArray = lines || DOM.codeEditor.value.split('\n');
    const foldedLines = getFoldedLinesSet();
    let html = '';
    let displayLineNumber = 0;

    for (let lineIndex = 0; lineIndex < linesArray.length; lineIndex++) {
        // ---- 折叠隐藏行：渲染占位容器，保留高度但不显示数字 ----
        // 目的：使行号列的垂直位置与 textarea 严格对齐。
        //
        // 关键：第二个 span 必须包含一个字符（此处为 U+200B 零宽空格）
        // 才能撑开行高。若留空，block 元素高度为 0，会导致后续行号上移。
        //
        // line-container-folded 类名由 css/styles.css 提供视觉样式：
        // 折叠隐藏行显示为略深的背景 + 半透明。
        if (foldedLines.has(lineIndex)) {
            html += '<div class="line-container line-container-folded" role="listitem" aria-hidden="true">';
            html += '<span class="fold-marker" style="visibility:hidden;opacity:0;"></span>';
            html += '<span>' + ZERO_WIDTH_SPACE + '</span>';
            html += '</div>\n';
            continue;
        }

        displayLineNumber++;
        html += '<div class="line-container" role="listitem">';

        // ---- 折叠标记 ----
        if (lineIndex < linesArray.length - 1) {
            const range = findFoldRange(linesArray, lineIndex);
            if (range) {
                const isCurrentlyFolded = EditorState.foldedRanges.some(function(r) {
                    return r.startLine === lineIndex;
                });
                const countText = isCurrentlyFolded && range.endLine - range.startLine > 0
                    ? ' (' + (range.endLine - range.startLine) + ')'
                    : '';
                const markerSymbol = isCurrentlyFolded ? '▶' + countText : '▼';
                const markerClass = isCurrentlyFolded ? 'folded' : 'unfolded';
                html += '<span class="fold-marker ' + markerClass + '" data-line="' + lineIndex + '" title="折叠/展开">' + markerSymbol + '</span>';
            } else {
                html += '<span class="fold-marker" style="visibility:hidden;opacity:0;"></span>';
            }
        } else {
            html += '<span class="fold-marker" style="visibility:hidden;opacity:0;"></span>';
        }

        html += '<span>' + displayLineNumber + '</span></div>\n';
    }

    DOM.lineNumbers.innerHTML = html;
}

/**
 * 更新行号 / 字符数 / 大文件提示。
 *
 * 只 split 一次，同时用于行数统计与行号列渲染。
 */
export function updateLineNumbers() {
    const codeText = DOM.codeEditor.value;
    DOM.charCountEl.textContent = '字符 ' + codeText.length;

    if (EditorState.largeFileActive) {
        DOM.lineCountEl.textContent = '行 大文件';
        DOM.lineNumbers.innerHTML = '<div style="padding: 8px; text-align: center; color: var(--text-secondary); font-size: 12px;">大文件</div>';
        return;
    }

    const lines = codeText.split('\n');
    DOM.lineCountEl.textContent = '行 ' + lines.length;
    renderLineNumbersWithFolds(lines);
}

/**
 * 更新光标位置 / 选区信息。
 */
export function updateCursorPosition() {
    if (EditorState.largeFileActive) {
        DOM.cursorPosEl.textContent = '行 -- 列 --';
        return;
    }

    const selectionStart = DOM.codeEditor.selectionStart;
    const selectionEnd = DOM.codeEditor.selectionEnd;
    const codeText = DOM.codeEditor.value;

    if (selectionStart !== selectionEnd) {
        const selectedText = codeText.substring(selectionStart, selectionEnd);
        const selectedLineCount = selectedText.split('\n').length;
        DOM.cursorPosEl.textContent = '选中 ' + selectedText.length + ' 字符 / ' + selectedLineCount + ' 行';
    } else {
        const textBeforeCursor = codeText.substring(0, selectionStart);
        const linesBeforeCursor = textBeforeCursor.split('\n');
        const currentRow = linesBeforeCursor.length;
        const currentColumn = linesBeforeCursor[linesBeforeCursor.length - 1].length + 1;
        DOM.cursorPosEl.textContent = '行 ' + currentRow + ' 列 ' + currentColumn;
    }
}

/**
 * 同步行号与编辑器滚动。
 */
export function syncLineNumbersScroll() {
    DOM.lineNumbers.scrollTop = DOM.codeEditor.scrollTop;
}

/**
 * 滚动到光标位置。使用 CSS 计算出的实际行高而非硬编码。
 */
export function scrollToCursor() {
    if (EditorState.largeFileActive) return;

    const editor = DOM.codeEditor;
    const cursorPosition = editor.selectionStart;
    const textBeforeCursor = editor.value.substring(0, cursorPosition);
    const currentLineIndex = textBeforeCursor.split('\n').length - 1;

    const computedStyle = getComputedStyle(editor);
    const lineHeightPx = parseFloat(computedStyle.lineHeight) || EditorState.currentFontSize * 1.7;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 12;

    const targetScrollTop = currentLineIndex * lineHeightPx + paddingTop - editor.clientHeight / 3;
    editor.scrollTop = Math.max(0, targetScrollTop);

    DOM.lineNumbers.scrollTop = editor.scrollTop;
    syncShadowScroll();
}