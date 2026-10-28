# Changelog

## 2.0.0

### Breaking changes

- **Shopify Admin API 2026-01 or newer is required.** `runBulkQuery` and
  `runBulkMutation` now wait on the operation they started, by id, using
  `bulkOperation(id:)`, which Shopify added in 2026-01.
- **Node.js 22 or newer is required.**
- **The spinner is off by default.** Pass `spinner: true` to show it.
- **Empty results yield nothing.** `runBulkQuery` and `runBulkMutation` used to
  throw `No bulk objects found` when nothing matched. The generator is now
  empty instead.
- **Removed the "newest operation of a type" methods**, which could pick up an
  operation someone else started:

  | Removed                            | Use instead                                                                        |
  | ---------------------------------- | ---------------------------------------------------------------------------------- |
  | `pollCurrentOperation(type)`       | `waitForBulkOperation(id)`                                                         |
  | `getBulkOperationStatus(type)`     | `getBulkOperation(id)`                                                             |
  | `cancelCurrentBulkOperation(type)` | `cancelBulkOperation(id)`                                                          |
  | `runLastBulkQuery()`               | Keep the `id` from `startBulkQuery`, then `waitForBulkOperation(id)` and `streamURL(operation.url)` |

- **Errors.** When Shopify refuses to start an operation, Bulkify throws
  `BulkifyUserError` with Shopify's message, instead of logging it and throwing
  `User errors found`. Operations that fail, are canceled or expire throw
  `BulkifyOperationError`, with the final operation on `error.operation`.
- **Types.** `createBulkQuery`, `createBulkMutation` and `cancelBulkOperation`
  return types generated from Shopify's schema. They allow `null` where
  Shopify can return it, which may surface new TypeScript errors.
- **Result files** are downloaded to a `bulkify` folder in the system temp
  directory by default (it used to be inside the package's own folder), with a
  `.jsonl` extension.

### Fixed

- `BulkifyUserError.inProgress` is also `true` for `LIMIT_REACHED`, which
  Shopify returns once the store's limit of concurrent operations is reached.
- `startBulkQuery` always sent `groupObjects: null`, which Shopify rejects, so
  it failed on every call unless `groupObjects` was set.
- `runBulkQuery` and `runBulkMutation` could follow another operation running
  on the same store instead of their own.
- Queries and mutations containing quotes, `"""` or line breaks broke the
  request. They're now sent as GraphQL variables, so multi-line mutations work.
- An expired or failed results download now throws
  `Couldn't download results (<status>)` instead of a JSON parse error.
- Uploading a mutation's JSONL file no longer depends on parsing the storage
  provider's XML response. It uses the upload key Shopify returns.

### Added

- Types for Bulkify's own GraphQL operations, generated from Shopify's Admin
  schema (`pnpm codegen`).
- `RUN_BULK_MUTATION` and `STAGED_UPLOADS_CREATE` are exported alongside
  `RUN_BULK_QUERY` and `GET_BULK_OPERATION`.

### Removed

- The `fast-xml-parser` dependency.

## 1.9.0

- `request` option to send Bulkify's calls through your own client.
- `startBulkQuery`, `getBulkOperation`, `waitForBulkOperation` and
  `streamURL` for working with operations by id.
- `spinner` option.
