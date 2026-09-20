// filename: js/folding.js
/**
 * ============================================================================
 * folding.js — 代码折叠
 * ============================================================================
 *
 * 【本次更新】
 *   1. 修复顶层块无法折叠（A3）：移除 baseIndent === 0 提前返回。
 *
 *   2. 修复 A3 修复引入的新 bug（闭合行误判）：
 *      原"跳过所有空行找到第一个缩进 > baseIndent 的非空行"逻辑，
 *      会把闭合行（如 `}`）误判为折叠起点 —— 因为紧随其后的下一块
 *      的非空行缩进更深，被错误地当作该闭合行的"块内容"。
 *
 *      新逻辑采用"紧邻下一非空行缩进必须更深"的严格判定：
 *        · 跳过空行后取到紧邻的下一非空行
 *        · 若该行缩进 <= baseIndent，则当前行不是折叠起点
 *        · 只有"下一非空行缩进 > baseIndent"才视为块的开启行
 *      这样：
 *        · 顶层 function / class / def / <html> 仍可折叠 ✓
 *        · 闭合行 `}` / `)` / `]` 不再误判 ✓
 *        · 空块（如 `class Foo {}`）不产生折叠 ✓
 *
 *   3. 折叠后高亮层/行号列错位（A2）的配套缓存已落地：
 *      getFoldedLinesSet 基于 EditorState.foldedRangesVersion 缓存。
 *
 *   4. 折叠范围变更时统一自增 EditorState.foldedRangesVersion，
 *      供 line-numbers.js / highlight.js 的缓存失效判断使用。
 *
 *   5. line-container-folded 类名已由 css/styles.css 提供视觉样式：
 *      折叠隐藏行的行号列会显示为略深的背景 + 半透明，
 *      让用户能直观感知"这块被折叠了"。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { STORAGE_KEYS } from './config.js';
import { saveToLocalStorage } from './util.js';
import { DOM } from './dom.js';
import { scheduleHighlightUpdate } from './highlight.js';

// ==================== 折叠范围计算 ====================

/**
 * 获取某一行的缩进层级（前导空白字符数）。
 */
export function getLineIndentLevel(line) {
    const indentMatch = line.match(/^[ \t]*/);
    if (!indentMatch) return 0;
    return indentMatch[0].length;
}

/**
 * 查找从 startLineIndex 起可折叠的范围。
 *
 * 返回 { startLine, endLine } 或 null。
 *
 * 语义：
 *   · startLineIndex 是折叠标记所在行（保持可见）
 *   · 返回的 [startLine + 1, endLine] 是折叠后隐藏的行范围
 *   · 起始行为空行时不产生折叠
 *   · 起始行的"紧邻下一非空行"缩进必须比 baseIndent 更深
 *
 * 该判定同时满足：
 *   · 顶层 function / class / def / <html> 可折叠（缩进 0 也可）
 *   · 闭合行 `}` 后紧跟同级块的行，不会被误判为折叠起点
 *   · 空块（下一非空行缩进不深）不产生折叠标记
 */
export function findFoldRange(lines, startLineIndex) {
    if (startLineIndex >= lines.length - 1) return null;

    // 起始行为空行 → 不产生折叠（避免空白行吞掉下方块）
    if (lines[startLineIndex].trim() === '') return null;

    const baseIndent = getLineIndentLevel(lines[startLineIndex]);

    // ---- 关键修复：紧邻下一非空行必须缩进更深 ----
    // 先跳过起始行之后的所有空行，定位到紧邻的下一非空行。
    let foldStart = startLineIndex + 1;
    while (foldStart < lines.length && lines[foldStart].trim() === '') {
        foldStart++;
    }
    if (foldStart >= lines.length) return null;

    // 若紧邻下一非空行缩进 <= baseIndent，则当前行不是块起点。
    // 这一判定排除了：
    //   · 闭合行（`}` 后跟同级 `if` / `function` 等）
    //   · 单行语句（如 `a();` 后跟同级 `b();`）
    //   · 空块（`class Foo {}` 后跟同级内容）
    if (getLineIndentLevel(lines[foldStart]) <= baseIndent) return null;

    // ---- 计算块结束行（缩进 <= baseIndent 的第一个非空行，或文档末尾）----
    let endLineIndex = foldStart + 1;
    while (endLineIndex < lines.length) {
        const currentIndent = getLineIndentLevel(lines[endLineIndex]);
        if (currentIndent <= baseIndent && lines[endLineIndex].trim() !== '') break;
        endLineIndex++;
    }

    return { startLine: startLineIndex, endLine: endLineIndex - 1 };
}

// ==================== 持久化 ====================

export function updateFoldedRangesInStorage() {
    saveToLocalStorage(STORAGE_KEYS.FOLDED_RANGES, EditorState.foldedRanges);
}

// ==================== 行号点击处理器 ====================

export function setupLineNumberClickHandler() {
    DOM.lineNumbers.addEventListener('click', function(event) {
        if (EditorState.largeFileActive) return;
        const target = event.target;
        if (target.classList.contains('fold-marker')) {
            event.stopPropagation();
            const lineIndex = parseInt(target.dataset.line);
            if (isNaN(lineIndex)) return;
            toggleFold(lineIndex);
        }
    });
}

// ==================== 折叠切换 ====================

export function toggleFold(lineIndex) {
    if (EditorState.largeFileActive) return;
    const lines = DOM.codeEditor.value.split('\n');
    const range = findFoldRange(lines, lineIndex);
    if (!range) return;

    const existingIndex = EditorState.foldedRanges.findIndex(function(r) {
        return r.startLine === range.startLine;
    });

    if (existingIndex >= 0) {
        EditorState.foldedRanges.splice(existingIndex, 1);
    } else {
        range.foldedCount = range.endLine - range.startLine;
        EditorState.foldedRanges.push(range);
    }

    // 折叠范围变更：自增版本号，使所有缓存失效。
    EditorState.foldedRangesVersion++;

    updateFoldedRangesInStorage();
    scheduleHighlightUpdate();
}

// ==================== 折叠行集合（带版本缓存） ====================

// 缓存的折叠行集合
let cachedFoldedLinesSet = null;
// 缓存对应的版本号
let cachedFoldedLinesVersion = -1;

/**
 * 获取所有"被折叠隐藏"的行索引集合。
 *
 * 折叠范围 [startLine, endLine] 中，隐藏的是 [startLine + 1, endLine]，
 * 起始行本身保持可见（用于显示 ▶ 折叠标记）。
 *
 * 结果基于 EditorState.foldedRangesVersion 缓存：
 *   · 版本号未变 → 直接返回缓存
 *   · 版本号变化 → 重建 Set 并更新缓存
 *
 * 避免 O(n×m) 重复计算。
 */
export function getFoldedLinesSet() {
    if (cachedFoldedLinesSet !== null && cachedFoldedLinesVersion === EditorState.foldedRangesVersion) {
        return cachedFoldedLinesSet;
    }

    const foldedLines = new Set();
    for (let rangeIndex = 0; rangeIndex < EditorState.foldedRanges.length; rangeIndex++) {
        const range = EditorState.foldedRanges[rangeIndex];
        for (let lineIndex = range.startLine + 1; lineIndex <= range.endLine; lineIndex++) {
            foldedLines.add(lineIndex);
        }
    }

    cachedFoldedLinesSet = foldedLines;
    cachedFoldedLinesVersion = EditorState.foldedRangesVersion;
    return foldedLines;
}

/**
 * 判断某行是否被折叠隐藏。
 */
export function isLineHidden(lineIndex) {
    for (let rangeIndex = 0; rangeIndex < EditorState.foldedRanges.length; rangeIndex++) {
        const range = EditorState.foldedRanges[rangeIndex];
        if (lineIndex > range.startLine && lineIndex <= range.endLine) return true;
    }
    return false;
}