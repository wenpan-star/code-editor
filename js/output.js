// filename: js/output.js
/**
 * ============================================================================
 * output.js — 输出面板
 * ============================================================================
 *
 * 本模块职责：
 *   1. 展开 / 收起输出面板
 *   2. 追加 / 批量追加输出行（stdout / stderr / success / info）
 *   3. 更新输出状态文本
 *   4. 缓存 stdin 输入
 *
 * 【本次更新】
 *   修复 stdinInput 每次输入都同步写 localStorage 的问题：
 *   原实现 input 事件 → saveStdinCache → localStorage.setItem 同步 IO。
 *   用户在 stdin 输入大段文本时，每次按键都会触发一次同步写盘。
 *   现改为：
 *     · input 事件 → 500ms 防抖保存
 *     · blur 事件 → 立即落盘一次（用户切回编辑器时确保数据已保存）
 *     · pagehide / beforeunload → 立即落盘兜底
 *   保证不丢失数据的同时，避免输入期间的高频写盘。
 *
 * 【保留】
 *   v8.1.1：点击"清空输出"后状态由 '就绪' 改为 '未运行'。
 *   幂等保护：bindOutputEvents 首次调用后置位标志，后续调用直接返回。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { STORAGE_KEYS } from './config.js';
import { DOM } from './dom.js';
import { saveToLocalStorage, loadFromLocalStorage } from './util.js';

// ==================== stdin 保存防抖 ====================

// stdin 保存防抖定时器
let stdinSaveDebounceTimer = null;
// stdin 保存防抖时长（毫秒）
const STDIN_SAVE_DEBOUNCE_MS = 500;
// 幂等保护：防止 bindOutputEvents 被重复调用导致监听器累积
let isOutputEventsBound = false;

// ==================== 面板开关 ====================

export function openOutputPanel() {
    DOM.outputPanel.classList.add('open');
    EditorState.outputPanelOpen = true;
    DOM.outputPanel.style.maxHeight = EditorState.outputPanelHeight + 'px';
}

export function closeOutputPanel() {
    DOM.outputPanel.classList.remove('open');
    EditorState.outputPanelOpen = false;
}

export function toggleOutputPanel() {
    if (EditorState.outputPanelOpen) closeOutputPanel();
    else openOutputPanel();
}

// ==================== 输出内容 ====================

export function appendOutputLinesBatch(lines) {
    const placeholder = DOM.outputContent.querySelector('.output-placeholder');
    if (placeholder) placeholder.remove();

    const fragment = document.createDocumentFragment();
    for (const lineData of lines) {
        const lineSpan = document.createElement('span');
        lineSpan.className = lineData.type + '-line';
        lineSpan.textContent = lineData.text;
        fragment.appendChild(lineSpan);
        if (!lineData.text.endsWith('\n')) {
            const newlineSpan = document.createElement('span');
            newlineSpan.textContent = '\n';
            fragment.appendChild(newlineSpan);
        }
    }
    DOM.outputContent.appendChild(fragment);
    DOM.outputContent.scrollTop = DOM.outputContent.scrollHeight;
}

export function appendOutputLine(text, type) {
    appendOutputLinesBatch([{ text: text, type: type }]);
}

export function setOutputStatus(text, color) {
    DOM.outputStatus.textContent = text;
    DOM.outputStatus.style.color = color || 'var(--text-secondary)';
}

// ==================== stdin 缓存 ====================

/**
 * 立即把 stdin 输入框内容写入 localStorage。
 */
export function saveStdinCache() {
    saveToLocalStorage(STORAGE_KEYS.STDIN_CACHE, DOM.stdinInput.value);
}

/**
 * 防抖版本：连续输入时只在最后一次输入后 STDIN_SAVE_DEBOUNCE_MS
 * 触发一次 saveStdinCache。
 */
function scheduleStdinSaveDebounced() {
    if (stdinSaveDebounceTimer !== null) {
        clearTimeout(stdinSaveDebounceTimer);
    }
    stdinSaveDebounceTimer = setTimeout(function() {
        stdinSaveDebounceTimer = null;
        saveStdinCache();
    }, STDIN_SAVE_DEBOUNCE_MS);
}

/**
 * 立即落盘：清空待处理的防抖定时器并写盘一次。
 * 用于 blur / pagehide / beforeunload。
 */
function flushStdinSaveImmediately() {
    if (stdinSaveDebounceTimer !== null) {
        clearTimeout(stdinSaveDebounceTimer);
        stdinSaveDebounceTimer = null;
    }
    saveStdinCache();
}

export function restoreStdinCache() {
    DOM.stdinInput.value = loadFromLocalStorage(STORAGE_KEYS.STDIN_CACHE, '');
}

// ==================== 事件绑定 ====================

/**
 * 绑定输出面板事件。
 *
 * 幂等：首次调用后 isOutputEventsBound = true，后续直接返回。
 */
export function bindOutputEvents() {
    if (isOutputEventsBound) return;
    isOutputEventsBound = true;

    DOM.outputPanelHeader.addEventListener('click', function(event) {
        if (event.target === DOM.btnClearOutput || DOM.btnClearOutput.contains(event.target)) return;
        toggleOutputPanel();
    });

    DOM.btnClearOutput.addEventListener('click', function(event) {
        event.stopPropagation();
        DOM.outputContent.innerHTML = '<span class="output-placeholder">输出已清空</span>';
        // v8.1.1：由 '就绪' 改为 '未运行'，语义更准确。
        DOM.outputStatus.textContent = '未运行';
    });

    // stdin 输入：防抖保存（避免每按键一次同步写盘）
    DOM.stdinInput.addEventListener('input', scheduleStdinSaveDebounced);
    // stdin 失焦：立即落盘，确保用户切换到编辑器时数据已保存
    DOM.stdinInput.addEventListener('blur', flushStdinSaveImmediately);
    // 页面隐藏 / 卸载：兜底落盘，避免用户输入后直接关闭标签页时丢失
    window.addEventListener('pagehide', flushStdinSaveImmediately);
    window.addEventListener('beforeunload', flushStdinSaveImmediately);
}