# Batch API Client

> High-performance batch API client with adaptive batching, retry logic, and per-item status tracking.

[![npm version](https://img.shields.io/npm/v/batch-api-client)](https://www.npmjs.com/package/batch-api-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

The Batch API Client transforms N individual HTTP requests into a single batched request, delivering **up to 20x throughput improvement** for bulk operations.

Based on the **Batch API Design Pattern** from [EvoMap](https://evomap.dev) — a proven pattern for high-volume API operations.

## Features

- **🚀 Up to 20x throughput** — batch N requests into 1 HTTP round trip
- **⚡ Adaptive batching** — dynamically adjusts flush interval based on error rates
- **🔁 Automatic retry** — exponential backoff for failed items
- **📊 Per-item status tracking** — each operation gets its own result with status code
- **🎯 Idempotency keys** — prevent duplicate operations on retries
- **🌊 Concurrency control** — configurable parallel batch execution
- **💪 TypeScript native** — full type safety out of the box

## Quick Start

```bash
npm install batch-api-client
```

### Basic Usage

```typescript
import { BatchClient } from 'batch-api-client';

const client = new BatchClient({
  baseUrl: 'https://api.example.com',
  batchSize: 50,       // Max items per batch
  concurrency: 3,       // Parallel batches
});

// Queue individual operations
const [userResult, orderResult] = await Promise.all([
  client.add({ method: 'GET', path: '/users/123' }),
  client.add({ method: 'GET', path: '/orders/456' }),
]);

console.log(userResult.data);   // { id: 123, name: 'Alice' }
console.log(orderResult.data);  // { id: 456, total: 99.99 }

// Bulk add
const users = await client.addAll([
  { method: 'GET', path: '/users/1' },
  { method: 'GET', path: '/users/2' },
  { method: 'GET', path: '/users/3' },
]);
```

### With POST/Create Operations

```typescript
const results = await client.addAll([
  {
    method: 'POST',
    path: '/users',
    body: { name: 'Alice', email: 'alice@example.com' },
  },
  {
    method: 'POST',
    path: '/users',
    body: { name: 'Bob', email: 'bob@example.com' },
  },
]);

console.log(results[0].status);  // 201 Created
console.log(results[1].status);  // 201 Created
```

### Server-Side Batch Endpoint (Reference)

Your server should implement a `/batch` endpoint:

```typescript
// Example server endpoint
app.post('/batch', async (req, res) => {
  const { operations } = req.body;

  const results = await Promise.all(
    operations.map((op, i) => executeOperation(op).then(
      data => ({ index: i, status: 200, data }),
      error => ({ index: i, status: error.status || 500, error: error.message })
    ))
  );

  res.json({
    results,
    summary: {
      total: results.length,
      succeeded: results.filter(r => r.status < 400).length,
      failed: results.filter(r => r.status >= 400).length,
    },
  });
});
```

## API Reference

### `new BatchClient(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | **required** | Base URL for all API requests |
| `headers` | `Record<string, string>` | `{}` | Default headers for every request |
| `batchSize` | `number` | `50` | Max items per batched request |
| `concurrency` | `number` | `3` | Max parallel batch requests |
| `timeoutMs` | `number` | `30000` | Request timeout per batch (ms) |
| `maxRetries` | `number` | `3` | Max retry attempts per failed item |
| `retryBaseDelayMs` | `number` | `1000` | Base delay for exponential backoff (ms) |
| `adaptiveBatching` | `boolean` | `true` | Enable adaptive flush interval based on error rate |
| `onBatchComplete` | `(results) => void` | — | Callback fired after each batch completes |
| `onRetry` | `(op, attempt, error) => void` | — | Callback fired before each retry attempt |

### `client.add(operation)`

Queue a single operation. Returns a Promise that resolves with the operation's result.

```typescript
const result = await client.add({
  method: 'POST',          // GET | POST | PUT | PATCH | DELETE
  path: '/resources',       // API path (appended to baseUrl)
  body: { ... },            // Request body (for POST/PUT/PATCH)
  headers: { ... },         // Per-request headers (merged with defaults)
  idempotencyKey: 'key-1',  // Unique key for deduplication on retry
});
```

### `client.addAll(operations)`

Queue multiple operations at once. Returns Promise resolving to all results.

### `client.flush()`

Immediately flush all queued operations. Called automatically when batch size is reached.

### `client.destroy()`

Clean up resources — flushes pending items and cancels timers.

## Performance Comparison

| Scenario | Without Batch | With Batch | Improvement |
|----------|---------------|------------|-------------|
| 100 creates | 100 RTT | 1 RTT | **100x fewer round trips** |
| 1000 reads | 1000 RTT | 20 RTT | **50x fewer round trips** |
| Throughput | 1x | ~20x | **20x higher throughput** |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BatchClient                          │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │   Queue     │──▶│ Adaptive     │──▶│  HTTP      │  │
│  │  (N items)  │   │ Flush Timer  │   │  Batch Req │  │
│  └─────────────┘   └──────────────┘   └────────────┘  │
│                          │                  │           │
│                          ▼                  ▼           │
│                   ┌──────────────┐   ┌────────────┐   │
│                   │ Error Rate   │   │  Per-Item  │   │
│                   │ Tracker      │   │  Retry     │   │
│                   └──────────────┘   └────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Error Handling

```typescript
const result = await client.add({
  method: 'DELETE',
  path: '/users/nonexistent',
});

if (result.status === 404) {
  console.log('User not found');
} else if (result.error) {
  console.log('Error:', result.error);
}
```

All operations that fail after max retries will resolve with `status: 0` and an `error` message rather than rejecting. This lets you handle all results uniformly:

```typescript
const results = await client.addAll(operations);

const succeeded = results.filter(r => r.status >= 200 && r.status < 300);
const failed = results.filter(r => r.status === 0 || r.status >= 400);

console.log(`Created ${succeeded.length} items, ${failed.length} failed`);
```

## Adaptive Batching

The client monitors error rates and automatically adjusts:

- **Low error rate** → longer flush interval (more batching, higher throughput)
- **High error rate** → shorter flush interval (fail faster, retry sooner)

This prevents the "thundering herd" problem during server issues while maximizing throughput during normal operation.

## License

MIT © 2026
