// filename: js/line-numbers.js
/**
 * ============================================================================
 * line-numbers.js — 行号渲染 + 光标位置 + 滚动定位
 * ============================================================================
 *
 * 【本次重构】
 *   1. renderLineNumbersWithFolds 由 O(n²) 优化为 O(n)（P2）：
 *      原实现对每一行都调用 findFoldRange，每次调用都是 O(块长度)，
 *      整体最坏情况 O(n²)。在中等文件（数千行）下会出现明显的卡顿。
 *
 *      新实现分三步：
 *        · 一次 O(n) 扫描：计算每行的前导空白数（indentLevels）；
 *        · 一次 O(n) 反向扫描：计算每行"下一非空行"索引（nextNonEmptyLine）；
 *        · 判断某行是否是折叠起始行只需 O(1)：
 *            indentLevels[nextNonEmptyLine[i]] > indentLevels[i]
 *          与 findFoldRange 的判定语义完全一致。
 *
 *      同时把"当前是否已折叠"的查找从 O(m) 数组 some 改为 O(1) Map 查询。
 *      所有边界情况（空行、末行、连续空行、缩进层级变化）行为与原来等价。
 *
 *   2. 保留零宽空格占位（U+200B）修复折叠隐藏行高度塌缩。
 *   3. 保留 updateLineNumbers / updateCursorPosition /
 *      syncLineNumbersScroll / scrollToCursor。
 *   4. 保留折叠标记的符号与计数逻辑：
 *        · 已折叠：'▶ (n)'（n = endLine - startLine）
 *        · 未折叠：'▼'
 *   5. 保留全部原有导出接口与行为。
 *
 * 与 folding.js 的关系：
 *   · folding.js 提供 findFoldRange（在点击折叠标记时使用）与
 *     getFoldedLinesSet（返回当前被折叠隐藏的行集合）；
 *   · 本模块在渲染时不再逐行调用 findFoldRange，
 *     只做 O(1) 判定，保证与 findFoldRange 的语义严格一致。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { DOM } from './dom.js';
import { getFoldedLinesSet } from './folding.js';
import { syncShadowScroll } from './highlight.js';

// 零宽空格字符（U+200B）：
//   · 不占宽度；
//   · 在文本布局中占据一个行高（由 CSS line-height 决定）；
//   · 用于撑开折叠占位容器的高度，使其与普通行严格等高。
const ZERO_WIDTH_SPACE = '\u200B';

// ==================== 折叠起始行预计算 ====================

// 缓存：上一次预计算对应的行数组引用与结果。
// 当 lines 引用变化时（编辑器内容变化），重新预计算。
let cachedFoldableStartLinesResult = null;
let cachedFoldableStartLinesInput = null;

/**
 * O(n) 预计算所有"折叠起始行"。
 *
 * 判定逻辑与 folding.js 的 findFoldRange 等价：
 *   · 起始行非空；
 *   · 存在下一非空行；
 *   · 下一非空行的缩进严格大于当前行缩进。
 *
 * 返回 { foldableStartLines: Set<number>, indentLevels: number[], nextNonEmptyLine: number[] }。
 *
 * 之所以缓存：同一份 lines 在一次渲染周期内会被本模块与 highlight.js
 * 各用一次，避免重复扫描。缓存失效条件是 lines 引用变化。
 */
function computeFoldableStartLines(lines) {
    if (cachedFoldableStartLinesInput === lines && cachedFoldableStartLinesResult !== null) {
        return cachedFoldableStartLinesResult;
    }

    const totalLines = lines.length;
    const indentLevels = new Array(totalLines);
    for (let i = 0; i < totalLines; i++) {
        const match = lines[i].match(/^[ \t]*/);
        indentLevels[i] = match ? match[0].length : 0;
    }

    const nextNonEmptyLine = new Array(totalLines).fill(-1);
    let nextNonEmptyIdx = -1;
    for (let i = totalLines - 1; i >= 0; i--) {
        nextNonEmptyLine[i] = nextNonEmptyIdx;
        if (lines[i].trim() !== '') {
            nextNonEmptyIdx = i;
        }
    }

    const foldableStartLines = new Set();
    for (let i = 0; i < totalLines - 1; i++) {
        if (lines[i].trim() === '') continue;
        const next = nextNonEmptyLine[i];
        if (next === -1) continue;
        if (indentLevels[next] > indentLevels[i]) {
            foldableStartLines.add(i);
        }
    }

    cachedFoldableStartLinesInput = lines;
    cachedFoldableStartLinesResult = {
        foldableStartLines: foldableStartLines,
        indentLevels: indentLevels,
        nextNonEmptyLine: nextNonEmptyLine
    };
    return cachedFoldableStartLinesResult;
}

// ==================== 行号渲染 ====================

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

    // O(n) 预计算折叠起始行（结果缓存，供同一份 lines 重复使用）
    const foldInfo = computeFoldableStartLines(linesArray);
    const foldableStartLines = foldInfo.foldableStartLines;

    // O(m) 预计算：当前已折叠范围按起始行索引（O(1) 查询）
    const foldedRangesByStartLine = new Map();
    for (let ri = 0; ri < EditorState.foldedRanges.length; ri++) {
        const range = EditorState.foldedRanges[ri];
        foldedRangesByStartLine.set(range.startLine, range);
    }

    let html = '';
    let displayLineNumber = 0;

    for (let lineIndex = 0; lineIndex < linesArray.length; lineIndex++) {
        // ---- 折叠隐藏行：渲染占位容器，保留高度但不显示数字 ----
        // 第二个 span 必须包含一个字符（此处为 U+200B 零宽空格）
        // 才能撑开行高。若留空，block 元素高度为 0，会导致后续行号上移。
        if (foldedLines.has(lineIndex)) {
            html += '<div class="line-container line-container-folded" role="listitem" aria-hidden="true">';
            html += '<span class="fold-marker" style="visibility:hidden;opacity:0;"></span>';
            html += '<span>' + ZERO_WIDTH_SPACE + '</span>';
            html += '</div>\n';
            continue;
        }

        displayLineNumber++;
        html += '<div class="line-container" role="listitem">';

        // ---- 折叠标记（O(1) 判定是否为折叠起始行） ----
        if (foldableStartLines.has(lineIndex)) {
            const foldedRange = foldedRangesByStartLine.get(lineIndex);
            let markerSymbol;
            let markerClass;
            if (foldedRange) {
                const foldedLineCount = foldedRange.endLine - foldedRange.startLine;
                markerSymbol = '▶ (' + foldedLineCount + ')';
                markerClass = 'folded';
            } else {
                markerSymbol = '▼';
                markerClass = 'unfolded';
            }
            html += '<span class="fold-marker ' + markerClass + '" data-line="' + lineIndex + '" title="折叠/展开">' + markerSymbol + '</span>';
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