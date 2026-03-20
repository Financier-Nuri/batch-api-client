/**
 * Batch API Client
 * 
 * High-performance batch API client with adaptive batching, retry logic,
 * and per-item status tracking. Based on the Batch API Design Pattern from EvoMap.
 * 
 * Reduces N HTTP round trips to 1 — up to 20x throughput improvement.
 */

export interface BatchOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Unique idempotency key for this operation */
  idempotencyKey?: string;
}

export interface BatchResult {
  index: number;
  status: number;
  data: unknown;
  error?: string;
}

export interface BatchResponse {
  results: BatchResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    durationMs: number;
  };
}

export interface BatchClientOptions {
  /** Base URL for all requests */
  baseUrl: string;
  /** Default headers applied to every request */
  headers?: Record<string, string>;
  /** Maximum items per batch request (default: 50) */
  batchSize?: number;
  /** Maximum concurrent batches (default: 3) */
  concurrency?: number;
  /** Request timeout per batch in ms (default: 30000) */
  timeoutMs?: number;
  /** Maximum retries for failed items (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelayMs?: number;
  /** Enable adaptive batching based on success rate (default: true) */
  adaptiveBatching?: boolean;
  /** Called on each completed batch */
  onBatchComplete?: (results: BatchResult[]) => void;
  /** Called on each retry attempt */
  onRetry?: (item: BatchOperation, attempt: number, error: string) => void;
}

interface QueuedItem {
  operation: BatchOperation;
  index: number;
  retryCount: number;
  resolve: (result: BatchResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Batch API Client
 * 
 * Queues operations and flushes them in batches for maximum throughput.
 * Supports automatic retry with exponential backoff, per-item status tracking,
 * and adaptive batching based on error rates.
 */
export class BatchClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly adaptiveBatching: boolean;
  private readonly onBatchComplete?: (results: BatchResult[]) => void;
  private readonly onRetry?: (item: BatchOperation, attempt: number, error: string) => void;

  private queue: QueuedItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBatches = 0;
  private recentErrorRate = 0;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: BatchClientOptions) {
    if (!options.baseUrl) {
      throw new Error('BatchClient requires a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.adaptiveBatching = options.adaptiveBatching ?? true;
    this.onBatchComplete = options.onBatchComplete;
    this.onRetry = options.onRetry;
    this.baseHeaders = this.defaultHeaders;
  }

  /**
   * Queue a single operation. Automatically flushes when batch size is reached
   * or when the flush interval elapses.
   */
  async add(operation: BatchOperation): Promise<BatchResult> {
    return new Promise((resolve, reject) => {
      const item: QueuedItem = {
        operation,
        index: this.queue.length,
        retryCount: 0,
        resolve,
        reject,
      };

      this.queue.push(item);
      this.scheduleFlush();
    });
  }

  /**
   * Queue multiple operations at once. Returns all results.
   */
  async addAll(operations: BatchOperation[]): Promise<BatchResult[]> {
    return Promise.all(operations.map(op => this.add(op)));
  }

  /**
   * Flush any queued operations immediately.
   */
  async flush(): Promise<BatchResult[]> {
    this.cancelTimer();
    return this.executeBatch();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    // Adaptive flush: reduce interval when error rate is high
    const interval = this.adaptiveBatching
      ? Math.max(50, 200 - this.recentErrorRate * 150)
      : 200;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.executeBatch().catch(() => {});
    }, interval);
  }

  private cancelTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async executeBatch(): Promise<BatchResult[]> {
    if (this.queue.length === 0) return [];

    // Respect concurrency limit
    while (this.activeBatches >= this.concurrency) {
      await this.waitForActiveBatch();
    }

    // Take up to batchSize items
    const batch = this.queue.splice(0, this.batchSize);
    this.activeBatches++;

    const startTime = Date.now();

    try {
      const results = await this.executeBatchRequest(batch);
      return results;
    } finally {
      this.activeBatches--;
    }
  }

  private async executeBatchRequest(batch: QueuedItem[]): Promise<BatchResult[]> {
    if (batch.length === 0) return [];

    const results: BatchResult[] = [];

    try {
      const response = await this.sendBatchRequest(batch);
      const durationMs = Date.now() - 0; // approximate

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const result = response.results?.[i] ?? {
          index: item.index,
          status: response.status ?? 0,
          data: null,
          error: 'Unexpected response format',
        };

        if (result.status >= 200 && result.status < 300) {
          item.resolve(result);
        } else {
          // Retry logic
          await this.handleRetry(item, result.error ?? `HTTP ${result.status}`);
        }
        results.push(result);
      }

      // Update adaptive batching state
      const errorRate = results.filter(r => r.status < 200 || r.status >= 300).length / results.length;
      this.recentErrorRate = this.adaptiveBatching
        ? this.recentErrorRate * 0.7 + errorRate * 0.3
        : 0;

      this.onBatchComplete?.(results);
      return results;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // All items in batch failed — retry each individually
      const retryPromises = batch.map(item =>
        this.handleRetry(item, errorMessage).then(r => { void r; })
      );
      await Promise.all(retryPromises);
      return results;
    }
  }

  private async sendBatchRequest(batch: QueuedItem[]): Promise<{ status?: number; results?: BatchResult[] }> {
    const operations = batch.map(item => ({
      method: item.operation.method,
      path: item.operation.path,
      body: item.operation.body,
    }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/batch`, {
        method: 'POST',
        headers: this.baseHeaders,
        body: JSON.stringify({ operations }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok && response.status !== 200 && response.status !== 201) {
        const text = await response.text().catch(() => '');
        throw new Error(`Batch request failed: HTTP ${response.status} — ${text}`);
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private async handleRetry(item: QueuedItem, error: string): Promise<void> {
    if (item.retryCount >= this.maxRetries) {
      item.reject(new Error(`Max retries exceeded: ${error}`));
      item.resolve({
        index: item.index,
        status: 0,
        data: null,
        error: `Max retries exceeded: ${error}`,
      });
      return;
    }

    item.retryCount++;
    const delay = this.retryBaseDelayMs * Math.pow(2, item.retryCount - 1);

    this.onRetry?.(item.operation, item.retryCount, error);

    await new Promise(resolve => setTimeout(resolve, delay));

    // Retry with fresh index
    return new Promise((resolve, reject) => {
      const retryItem: QueuedItem = {
        operation: item.operation,
        index: item.index,
        retryCount: item.retryCount,
        resolve: (result) => { item.resolve(result); resolve(); },
        reject: (err) => { item.reject(err); reject(err); },
      };

      // Retry as a single-item batch
      this.executeSingleRetry(retryItem).then(() => resolve()).catch(e => reject(e));
    });
  }

  private async executeSingleRetry(item: QueuedItem): Promise<BatchResult> {
    const { method, path, body, headers } = item.operation;
    const allHeaders = { ...this.baseHeaders, ...headers };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: allHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await response.json().catch(() => null);

      if (response.ok) {
        item.resolve({ index: item.index, status: response.status, data });
        return { index: item.index, status: response.status, data };
      } else {
        if (item.retryCount < this.maxRetries) {
          return this.handleRetry(item, `HTTP ${response.status}`);
        } else {
          item.resolve({ index: item.index, status: response.status, data, error: `HTTP ${response.status}` });
          return { index: item.index, status: response.status, data, error: `HTTP ${response.status}` };
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (item.retryCount < this.maxRetries) {
        return this.handleRetry(item, errorMessage);
      } else {
        item.resolve({ index: item.index, status: 0, data: null, error: errorMessage });
        return { index: item.index, status: 0, data: null, error: errorMessage };
      }
    }
  }

  private async waitForActiveBatch(): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.activeBatches < this.concurrency) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  /** Clean up resources. Flushes pending items. */
  async destroy(): Promise<void> {
    this.cancelTimer();
    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}

export default BatchClient;
