// filename: js/history.js
/**
 * ============================================================================
 * history.js — 撤销/重做历史管理器
 * ============================================================================
 *
 * 【本次重构】
 *   修复 pushState / endBatch 历史栈溢出时 currentIndex 与数组错位（B5 完整修复）。
 *
 * 【根因】
 *   原实现在 history.push(newState) 之后判断长度是否超限：
 *     · 若超限，则 shift() 移除头部，并执行
 *         currentIndex = Math.max(0, currentIndex - 1);
 *     · 但 push 后新状态位于数组末尾，shift 后其索引已经是
 *         this.history.length - 1；
 *     · 把 currentIndex 递减 1 会让它指向"倒数第二个状态"，
 *       撤销/重做会跳错位置。
 *   该缺陷在历史记录超过 MAX_HISTORY (200) 后必现；
 *   在 setLargeFileMode 收缩容量后同样会触发。
 *
 * 【修复】
 *   1. push 后若超限，只 shift 一次；随后无条件设置
 *        this.currentIndex = this.history.length - 1;
 *      保证 currentIndex 始终指向"最新入栈的状态"。
 *   2. endBatch 采用完全相同的逻辑，避免两条入栈路径行为分叉。
 *   3. setLargeFileMode 容量收缩后，同样以 history.length - 1
 *      为新索引；空栈时置为 -1，符合"无历史"语义。
 *   4. 保留 force 参数语义：force === true 时跳过"状态相同则忽略"判断。
 *   5. 保留 setPaused 公开 API（当前业务未调用，供未来扩展）。
 * ============================================================================
 */

import { CONFIG } from './config.js';
import { EditorState } from './state.js';

export class HistoryManager {
    constructor(maxHistory, callbacks) {
        const callbacksObject = callbacks || {};
        this.history = [];
        this.currentIndex = -1;
        this.maxHistory = maxHistory || CONFIG.MAX_HISTORY;
        this.largeFileMaxHistory = CONFIG.LARGE_FILE_MAX_HISTORY;
        this.batchDepth = 0;
        this.pendingBatchState = null;
        this.historyPaused = false;
        this.isLargeFileMode = false;

        this.onStateApplied = callbacksObject.onStateApplied || null;
        this.onButtonsUpdate = callbacksObject.onButtonsUpdate || null;
    }

    captureState(editorElement) {
        return {
            code: editorElement.value,
            selectionStart: editorElement.selectionStart,
            selectionEnd: editorElement.selectionEnd
        };
    }

    applyState(state, editorElement) {
        if (!state) return;
        editorElement.value = state.code;
        editorElement.setSelectionRange(state.selectionStart, state.selectionEnd);
        this.dispatchEditorUpdate(editorElement);
    }

    /**
     * 主动派发 'input' 事件前先置位 internalEditorUpdate，
     * 让 editor.js 的 handleEditorInput 直接返回，避免重复处理。
     */
    dispatchEditorUpdate(editorElement) {
        EditorState.internalEditorUpdate = true;
        try {
            const event = new Event('input', { bubbles: true });
            editorElement.dispatchEvent(event);
        } finally {
            EditorState.internalEditorUpdate = false;
        }
        if (this.onStateApplied) this.onStateApplied();
    }

    /**
     * 记录当前编辑器状态到历史栈。
     *
     * @param {HTMLTextAreaElement} editorElement
     * @param {boolean} [force]
     *   · force === true → 强制记录，即使新状态与栈顶完全相同
     *   · force 省略 / false → 状态相同则跳过（默认行为）
     */
    pushState(editorElement, force) {
        const shouldForce = force === true;
        if (this.historyPaused) return;

        const newState = this.captureState(editorElement);
        if (this.batchDepth > 0) {
            this.pendingBatchState = newState;
            return;
        }

        // 状态去重：除非 force，否则与栈顶完全相同就不重复记录。
        if (!shouldForce && this.currentIndex >= 0 && this.history[this.currentIndex]) {
            const lastState = this.history[this.currentIndex];
            if (
                lastState.code === newState.code &&
                lastState.selectionStart === newState.selectionStart &&
                lastState.selectionEnd === newState.selectionEnd
            ) {
                return;
            }
        }

        // 若当前不在栈顶（撤销后再次编辑），截断后续"未来"状态。
        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(newState);

        // 容量裁剪：仅 shift 一次。随后统一用 history.length - 1 作为新索引，
        // 保证 currentIndex 永远指向"最新入栈的状态"，不会在多次裁剪后越界。
        const effectiveMax = this.isLargeFileMode ? this.largeFileMaxHistory : this.maxHistory;
        if (this.history.length > effectiveMax) {
            this.history.shift();
        }
        this.currentIndex = this.history.length - 1;

        this.updateButtons();
    }

    undo(editorElement) {
        if (this.historyPaused || !this.canUndo()) return false;
        this.currentIndex--;
        this.applyState(this.history[this.currentIndex], editorElement);
        this.updateButtons();
        return true;
    }

    redo(editorElement) {
        if (this.historyPaused || !this.canRedo()) return false;
        this.currentIndex++;
        this.applyState(this.history[this.currentIndex], editorElement);
        this.updateButtons();
        return true;
    }

    canUndo() {
        return this.currentIndex > 0;
    }

    canRedo() {
        return this.currentIndex < this.history.length - 1;
    }

    updateButtons() {
        if (this.onButtonsUpdate) this.onButtonsUpdate();
    }

    beginBatch() {
        this.batchDepth++;
    }

    endBatch(editorElement) {
        if (this.batchDepth > 0) this.batchDepth--;
        if (this.batchDepth === 0 && this.pendingBatchState) {
            if (this.historyPaused) {
                this.pendingBatchState = null;
                return;
            }
            const newState = this.pendingBatchState;
            this.pendingBatchState = null;

            if (this.currentIndex >= 0 && this.history[this.currentIndex]) {
                const lastState = this.history[this.currentIndex];
                if (
                    lastState.code === newState.code &&
                    lastState.selectionStart === newState.selectionStart &&
                    lastState.selectionEnd === newState.selectionEnd
                ) {
                    return;
                }
            }

            if (this.currentIndex < this.history.length - 1) {
                this.history = this.history.slice(0, this.currentIndex + 1);
            }

            this.history.push(newState);

            // 与 pushState 完全相同的裁剪与索引更新逻辑，避免两条入栈路径行为分叉。
            const effectiveMax = this.isLargeFileMode ? this.largeFileMaxHistory : this.maxHistory;
            if (this.history.length > effectiveMax) {
                this.history.shift();
            }
            this.currentIndex = this.history.length - 1;

            this.updateButtons();
        }
    }

    /**
     * 切换大文件模式。
     *
     * 容量收缩时逐次 shift，最终把 currentIndex 重置为 history.length - 1；
     * 空栈时置为 -1，语义为"无历史可撤销/重做"。
     */
    setLargeFileMode(isLargeFile) {
        this.isLargeFileMode = isLargeFile;
        if (isLargeFile) {
            const effectiveMax = this.largeFileMaxHistory;
            while (this.history.length > effectiveMax) {
                this.history.shift();
            }
            if (this.history.length === 0) {
                this.currentIndex = -1;
            } else {
                this.currentIndex = this.history.length - 1;
            }
        }
        this.updateButtons();
    }

    /**
     * 暂停 / 恢复历史记录。
     *
     * 典型场景：
     *   · 批量操作期间暂停历史记录，避免为每个子操作都记录一次
     *   · 程序化大规模修改时暂停，只记录最终结果
     *
     * 当前版本未在业务中调用，保留作为公开 API 供未来扩展。
     * 与 setLargeFileMode 的区别：
     *   · setLargeFileMode 只调整历史栈容量上限
     *   · setPaused 完全停止记录，并清空待处理的批量状态
     */
    setPaused(paused) {
        this.historyPaused = paused;
        if (paused) {
            this.pendingBatchState = null;
            this.updateButtons();
        }
    }
}

export let historyManager = null;

export function setHistoryManager(instance) {
    historyManager = instance;
}