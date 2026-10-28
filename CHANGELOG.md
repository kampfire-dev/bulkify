# Changelog

## 2.2.0

### Added

- **Typed results.** `BulkLine<T>` turns a query's result type into the types
  of its bulk result lines: one per connection node, without nested
  connections, and with `__parentId` on nested nodes.
- `runBulkQuery` types its lines from the query text when `BulkifyQueries`
  knows the query. Extending it with Shopify's codegen types (`AdminQueries`)
  takes one declaration; see "Typed results" in the README. Passing a type,
  `runBulkQuery<T>(query)`, works as before.
- `BulkifyQueries` and `BulkQueryLine` types.

## 2.1.0

### Added

- `runBulkQuery` and `createBulkQuery` take `{ groupObjects }`, like
  `startBulkQuery`. With `groupObjects: true`, each object's children come
  right after it in the results. Shopify warns that grouping makes operations
  slower and more likely to time out.
- `BulkQueryOptions` type.

### Fixed

- The README said a child line always comes after its parent. That's only
  true with `groupObjects: true`; by default the lines can come in any order.
  The `nested-results.ts` example now handles any order. Before, it dropped
  children that arrived before their parent.

## 2.0.0

The first release since 1.8.6. These notes cover everything since then.

### Breaking changes

- **Shopify Admin API 2026-01 or newer is required.** `runBulkQuery` and
  `runBulkMutation` now wait on the operation they started, by id, using
  `bulkOperation(id:)`, which Shopify added in 2026-01.
- **Node.js 22 or newer is required.**
- **Shopify's packages are no longer installed with Bulkify.**
  `@shopify/shopify-api`, `@shopify/admin-api-client` and
  `@shopify/graphql-client` used to be dependencies. If you import any of
  them, add them to your own `package.json`.
- **The terminal spinner is off by default.** It used to always show. Pass
  `spinner: true` to show it.
- **Empty results yield nothing.** `runBulkQuery` and `runBulkMutation` used to
  throw `No bulk objects found` when nothing matched. The generator is now
  empty instead.
- **Removed the "newest operation of a type" methods**, which could pick up an
  operation someone else started:

  | Removed                            | Use instead                                                                                         |
  | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
  | `pollCurrentOperation(type)`       | `waitForBulkOperation(id)`                                                                          |
  | `getBulkOperationStatus(type)`     | `getBulkOperation(id)`                                                                              |
  | `cancelCurrentBulkOperation(type)` | `cancelBulkOperation(id)`                                                                           |
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

### Added

- **Background jobs.** `startBulkQuery` starts a bulk query without waiting.
  `getBulkOperation(id)` and `waitForBulkOperation(id)` check on it, and
  `streamURL(url)` reads the results without writing a file.
- **Any client.** `client` accepts anything with Shopify's
  `request(query, { variables })` method, not only Shopify's two clients. The
  new `request` option takes a plain function instead, for example one that
  handles rate limits.
- **Error classes.** `BulkifyUserError`, whose `inProgress` is `true` when other
  bulk operations are running, and `BulkifyOperationError`.
- **`spinner` option.**
- **Generated types** for Bulkify's own GraphQL operations, from Shopify's
  Admin schema.
- **Exported operations:** `RUN_BULK_QUERY`, `RUN_BULK_MUTATION`,
  `GET_BULK_OPERATION` and `STAGED_UPLOADS_CREATE`.

### Fixed

- `runBulkQuery` and `runBulkMutation` could follow another operation running
  on the same store instead of their own.
- Queries and mutations containing quotes, `"""` or line breaks broke the
  request. They're now sent as GraphQL variables, so multi-line mutations work.
- An expired or failed results download now throws
  `Couldn't download results (<status>)` instead of a JSON parse error.
- Uploading a mutation's JSONL file no longer depends on parsing the storage
  provider's XML response. It uses the upload key Shopify returns.

### Removed

- The `fast-xml-parser` dependency.
