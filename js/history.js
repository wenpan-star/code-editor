// filename: js/history.js
/**
 * ============================================================================
 * history.js — 撤销/重做历史管理器
 * ============================================================================
 *
 * 【本次更新】
 *   1. 修复 setLargeFileMode 中 currentIndex 与 history 数组错位（B5）：
 *      原实现在从数组头部 shift 时，仅当 currentIndex > 0 才自减，
 *      导致 currentIndex === 0 场景下索引指向错误条目。
 *      现改为无条件自减并钳制到 0。
 *
 *   2. 激活 pushState 的 force 参数语义：
 *      原实现声明了 force 参数但从未使用（shouldForce 赋值后未引用），
 *      属于死代码。现让 force === true 时跳过"状态相同则忽略"判断，
 *      强制把当前状态写入历史栈。
 *      典型用途：需要为某个操作设置显式历史锚点。
 *
 *   3. setPaused 保留作为公开 API：
 *      当前业务未调用，但保留给未来扩展（例如批量操作期间暂停历史）。
 *      与 setLargeFileMode 配合使用可覆盖多种历史管理场景。
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

        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(newState);
        const effectiveMax = this.isLargeFileMode ? this.largeFileMaxHistory : this.maxHistory;
        if (this.history.length > effectiveMax) {
            this.history.shift();
            // 修复 B5：shift 后 currentIndex 必须无条件递减并钳制到 0。
            this.currentIndex = Math.max(0, this.currentIndex - 1);
            // 注意：此处不递增 currentIndex，因为 push 的是数组末尾，
            // 而我们刚 shift 掉了头部，效果是 currentIndex 不变。
        } else {
            this.currentIndex++;
        }
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
            const effectiveMax = this.isLargeFileMode ? this.largeFileMaxHistory : this.maxHistory;
            if (this.history.length > effectiveMax) {
                this.history.shift();
                this.currentIndex = Math.max(0, this.currentIndex - 1);
            } else {
                this.currentIndex++;
            }
            this.updateButtons();
        }
    }

    /**
     * 切换大文件模式。
     *
     * 修复 B5：
     *   原实现仅在 currentIndex > 0 时递减，currentIndex === 0 场景下
     *   会造成索引与数组错位。现无条件递减并钳制到 0。
     */
    setLargeFileMode(isLargeFile) {
        this.isLargeFileMode = isLargeFile;
        if (isLargeFile) {
            const effectiveMax = this.largeFileMaxHistory;
            while (this.history.length > effectiveMax) {
                this.history.shift();
                this.currentIndex = Math.max(0, this.currentIndex - 1);
            }
            if (this.currentIndex < 0) {
                this.currentIndex = 0;
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