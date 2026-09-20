// filename: js/storage.js
/**
 * ============================================================================
 * storage.js — 三层存储封装
 * ============================================================================
 *
 * 【本次更新】
 *   仅在文件首行补充 // filename: js/storage.js 标注，与项目约定统一。
 *   内容逻辑保持不变。
 *
 * 1. localStorage：小型缓存（主题、缩进、编辑内容 < 500KB）
 *    —— 由 util.js 提供 saveToLocalStorage / loadFromLocalStorage
 * 2. IndexedDB：大文件自动保存 + 保存目录句柄
 * 3. File System Access API 目录句柄：用户选择的保存目录
 *
 * 所有函数均包含异常处理，静默降级。
 *
 * 【目录句柄读取的状态区分】
 *   loadDirectoryHandleWithStatus() 返回四种状态：
 *     · 'granted'           —— 句柄存在且读写权限已授予
 *     · 'permission-denied' —— 句柄存在但读写权限已被系统撤销
 *     · 'not-set'           —— IndexedDB 中从未保存过目录句柄
 *     · 'error'             —— 读取过程抛错（IndexedDB 不可用等）
 *   这样 directory-io.js 能给出更精确的提示文案。
 * ============================================================================
 */

import { INDEXED_DB, DIR_HANDLE_DB } from './config.js';
import { EditorState } from './state.js';

// ==================== IndexedDB 自动保存 ====================

export function openAutoSaveDatabase() {
    return new Promise(function(resolve, reject) {
        const request = indexedDB.open(INDEXED_DB.NAME, INDEXED_DB.VERSION);
        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(INDEXED_DB.STORE_NAME)) {
                db.createObjectStore(INDEXED_DB.STORE_NAME);
            }
        };
        request.onsuccess = function(event) {
            EditorState.autoSaveDB = event.target.result;
            resolve(EditorState.autoSaveDB);
        };
        request.onerror = function(event) {
            console.error('无法打开 IndexedDB 自动保存数据库:', event.target.error);
            reject(event.target.error);
        };
    });
}

export function saveCodeToIndexedDB(code) {
    if (!EditorState.autoSaveDB) return Promise.reject('数据库未打开');
    return new Promise(function(resolve, reject) {
        const transaction = EditorState.autoSaveDB.transaction(INDEXED_DB.STORE_NAME, 'readwrite');
        const store = transaction.objectStore(INDEXED_DB.STORE_NAME);
        const putRequest = store.put(code, INDEXED_DB.KEY);
        putRequest.onsuccess = function() {
            resolve();
        };
        putRequest.onerror = function(event) {
            reject(event.target.error);
        };
    });
}

export function loadCodeFromIndexedDB() {
    if (!EditorState.autoSaveDB) return Promise.resolve(null);
    return new Promise(function(resolve, reject) {
        const transaction = EditorState.autoSaveDB.transaction(INDEXED_DB.STORE_NAME, 'readonly');
        const store = transaction.objectStore(INDEXED_DB.STORE_NAME);
        const getRequest = store.get(INDEXED_DB.KEY);
        getRequest.onsuccess = function() {
            resolve(getRequest.result || null);
        };
        getRequest.onerror = function(event) {
            reject(event.target.error);
        };
    });
}

// ==================== 目录句柄（File System Access API）====================

export function openDirectoryDB() {
    return new Promise(function(resolve, reject) {
        const request = indexedDB.open(DIR_HANDLE_DB.NAME, DIR_HANDLE_DB.VERSION);
        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(DIR_HANDLE_DB.STORE_NAME)) {
                db.createObjectStore(DIR_HANDLE_DB.STORE_NAME);
            }
        };
        request.onsuccess = function(event) {
            resolve(event.target.result);
        };
        request.onerror = function(event) {
            reject(event.target.error);
        };
    });
}

/**
 * 保存目录句柄到 IndexedDB。
 *
 * 使用 try / finally 结构，确保任意抛错路径下都关闭连接。
 * 对外行为不变（成功 resolve，失败 reject）。
 */
export async function saveDirectoryHandle(handle) {
    let db = null;
    try {
        db = await openDirectoryDB();
        const tx = db.transaction(DIR_HANDLE_DB.STORE_NAME, 'readwrite');
        tx.objectStore(DIR_HANDLE_DB.STORE_NAME).put(handle, DIR_HANDLE_DB.KEY);
        await new Promise(function(resolve, reject) {
            tx.oncomplete = resolve;
            tx.onerror = function(event) {
                reject(event.target.error);
            };
        });
    } finally {
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                // 连接关闭异常忽略（一般不会发生）
            }
        }
    }
}

/**
 * 读取目录句柄并附带状态。
 *
 * 区分四种场景，供 UI 层精确提示：
 *   · 'granted'          —— 句柄存在且读写权限已授予。
 *                           handle 字段为 FileSystemDirectoryHandle。
 *   · 'permission-denied' —— 句柄存在但读写权限已被系统撤销。
 *                           handle 字段仍返回句柄（可用于 startIn）。
 *   · 'not-set'          —— IndexedDB 中从未保存过目录句柄。
 *                           handle 字段为 null。
 *   · 'error'            —— 读取过程抛错（IndexedDB 不可用等）。
 *                           handle 字段为 null。
 *
 * 使用 try / finally 结构，确保在任意抛错路径下都关闭连接。
 * 所有异常被捕获并以 'error' 状态返回，永不向上抛错。
 *
 * @returns {Promise<{ handle: FileSystemDirectoryHandle | null, status: string }>}
 */
export async function loadDirectoryHandleWithStatus() {
    let db = null;
    try {
        db = await openDirectoryDB();
        const tx = db.transaction(DIR_HANDLE_DB.STORE_NAME, 'readonly');
        const getRequest = tx.objectStore(DIR_HANDLE_DB.STORE_NAME).get(DIR_HANDLE_DB.KEY);
        const handle = await new Promise(function(resolve, reject) {
            getRequest.onsuccess = function() {
                resolve(getRequest.result);
            };
            getRequest.onerror = function(event) {
                reject(event.target.error);
            };
        });
        if (!handle) {
            return { handle: null, status: 'not-set' };
        }
        if (handle.queryPermission) {
            const permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                return { handle: handle, status: 'permission-denied' };
            }
        }
        return { handle: handle, status: 'granted' };
    } catch (loadError) {
        // IndexedDB 不可用、数据库不存在、句柄查询失败等：统一返回 'error'。
        return { handle: null, status: 'error' };
    } finally {
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                // 忽略
            }
        }
    }
}

/**
 * 读取目录句柄（向后兼容包装器）。
 *
 * 使用 loadDirectoryHandleWithStatus 实现，仅返回 'granted' 状态下的句柄。
 * 对于 'permission-denied' / 'not-set' / 'error' 一律返回 null。
 *
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export async function loadDirectoryHandle() {
    const loadResult = await loadDirectoryHandleWithStatus();
    return loadResult.status === 'granted' ? loadResult.handle : null;
}

/**
 * 读取保存的目录句柄，但**不做权限检查**。
 *
 * 用途：作为 window.showDirectoryPicker 的 startIn 选项，使对话框下次
 * 打开时自动定位到上次选择的目录。即使句柄的读 / 写权限已被系统撤销，
 * 其路径信息通常依然可用，可作为初始位置提示。
 *
 * 返回值：
 *   - 成功且存在句柄：返回该 FileSystemDirectoryHandle
 *   - 无保存句柄或读取失败：返回 null
 *
 * 所有异常被捕获，永不抛错，调用方无需 try / catch。
 */
export async function loadDirectoryHandleForStartIn() {
    let db = null;
    try {
        db = await openDirectoryDB();
        const tx = db.transaction(DIR_HANDLE_DB.STORE_NAME, 'readonly');
        const getRequest = tx.objectStore(DIR_HANDLE_DB.STORE_NAME).get(DIR_HANDLE_DB.KEY);
        const handle = await new Promise(function(resolve, reject) {
            getRequest.onsuccess = function() {
                resolve(getRequest.result);
            };
            getRequest.onerror = function(event) {
                reject(event.target.error);
            };
        });
        return handle || null;
    } catch (loadError) {
        // IndexedDB 不可用、数据库不存在、句柄已失效等情况下，
        // 静默返回 null；调用方回退到默认起始位置。
        return null;
    } finally {
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                // 忽略
            }
        }
    }
}

/**
 * 清除已保存的目录句柄。
 *
 * 使用 try / finally 结构，确保任意抛错路径下都关闭连接。
 */
export async function clearDirectoryHandle() {
    let db = null;
    try {
        db = await openDirectoryDB();
        const tx = db.transaction(DIR_HANDLE_DB.STORE_NAME, 'readwrite');
        tx.objectStore(DIR_HANDLE_DB.STORE_NAME).delete(DIR_HANDLE_DB.KEY);
        await new Promise(function(resolve) {
            tx.oncomplete = resolve;
        });
    } finally {
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                // 忽略
            }
        }
    }
}

/**
 * 写入文件到指定目录句柄。
 *
 * 使用 try/finally 确保 writable 在任何路径下都被 close，
 * 避免写入抛错时文件句柄泄漏。
 */
export async function writeFileToDirectory(directoryHandle, filename, contentArrayBuffer) {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(contentArrayBuffer);
    } finally {
        try {
            await writable.close();
        } catch (closeError) {
            // 关闭异常忽略，避免掩盖 write 阶段的原始错误
        }
    }
}