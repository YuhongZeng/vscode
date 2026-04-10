// ---------------------------------------------------------
// 1. 高性能固定长度环形队列 (Ring Buffer)
// ---------------------------------------------------------
export interface Breadcrumb {
    timestamp: number;
    category: 'IPC' | 'FILE' | 'EXTENSION' | 'SYSTEM';
    action: string;
    payloadSize?: number;
    metadata?: string;
}

export class RingBuffer<T> {
    private buffer: T[];
    private head: number = 0;
    private readonly maxSize: number;

    constructor(maxSize: number = 200) {
        this.maxSize = maxSize;
        this.buffer = new Array(maxSize); // 预分配，避免运行时的数组扩容开销
    }

    push(item: T) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.maxSize;
    }

    toArray(): T[] {
        const result: T[] = [];
        for (let i = 0; i < this.maxSize; i++) {
            const idx = (this.head + i) % this.maxSize;
            if (this.buffer[idx] !== undefined) {
                result.push(this.buffer[idx]);
            }
        }
        return result;
    }
}

// ---------------------------------------------------------
// 2. 诊断监控器主类 (环境无关基础版)
// ---------------------------------------------------------
export class OOMDiagnosticMonitor {
    private static _instance: OOMDiagnosticMonitor;

    protected breadcrumbs = new RingBuffer<Breadcrumb>(200);

    protected constructor() {}

    static getInstance(): OOMDiagnosticMonitor {
        if (!this._instance) {
            this._instance = new OOMDiagnosticMonitor();
        }
        return this._instance;
    }

    /** 允许 Node 环境注入更强大的实现 */
    static setInstance(instance: OOMDiagnosticMonitor): void {
        this._instance = instance;
    }

    /**
     * 记录关键操作黑匣子，O(1) 开销
     */
    public recordEvent(category: Breadcrumb['category'], action: string, payloadSize?: number, metadata?: string) {
        this.breadcrumbs.push({
            timestamp: Date.now(),
            category,
            action,
            payloadSize,
            metadata
        });
    }

    /**
     * 获取所有面包屑的当前快照 (用于沙盒环境 IPC 发送)
     */
    public getBreadcrumbsSnapshot(): Breadcrumb[] {
        return this.breadcrumbs.toArray();
    }

    /**
     * 在 Common 环境下为空实现，由 Node 子类覆写
     */
    public startMonitoring(processName: string = 'unknown'): void {
        // noop in common
    }
}
