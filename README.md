# Bulkify

**Bulkify** runs Shopify [bulk operations](https://shopify.dev/docs/api/usage/bulk-operations/queries) from Node.js. It starts the operation, waits for it to finish and streams the results back one line at a time, so large exports and imports don't have to fit in memory.

- **Streams results** with async generators
- **Bulk queries and bulk mutations**, including uploading the JSONL file for mutations
- **Works with any client**: Shopify's GraphQL clients, or your own request function (for example one that handles rate limits)
- **Background jobs**: start an operation, then check on it or read its results later by id
- **Typed results**: with Shopify's codegen, each result line is typed from your query

## Upgrading to 2.0

2.0 is the first release since 1.8.6. It needs Admin API 2026-01 or newer and
Node.js 22 or newer, no longer installs Shopify's client packages for you, and
removes the methods that worked with "the newest operation of a type". See the
[changelog](CHANGELOG.md#200) for everything that changed and what to use
instead.

## Requirements

- Node.js 22 or newer
- Shopify Admin API **2026-01 or newer**. Bulkify follows operations by id with `bulkOperation(id:)`, which Shopify added in 2026-01

## Installation

```bash
npm install @kampfire/bulkify
```

Bulkify works with the Shopify GraphQL client you already use. If you don't
have one, `@shopify/admin-api-client` is the smallest:

```bash
npm install @shopify/admin-api-client
```

## Quick start

```ts
import { createAdminApiClient } from "@shopify/admin-api-client";
import Bulkify from "@kampfire/bulkify";

const client = createAdminApiClient({
  storeDomain: "your-store.myshopify.com",
  accessToken: process.env.API_ACCESS_TOKEN!,
  apiVersion: "2026-10",
});

const bulkify = new Bulkify({ client, spinner: true });

const { generator } = await bulkify.runBulkQuery<{ id: string; title: string }>(`{
  products(query: "tag:sale") {
    edges {
      node {
        id
        title
      }
    }
  }
}`);

for await (const product of generator) {
  console.log(product.id, product.title);
}
```

The `GraphqlClient` from `@shopify/shopify-api` works too:

```ts
const client = new shopify.clients.Graphql({ session });
const bulkify = new Bulkify({ client });
```

## Bulk mutations

Write one line of variables per call to a JSONL file, then pass the mutation
and the file. Bulkify uploads the file, runs the mutation and streams back one
result per line.

```ts
import fs from "node:fs/promises";

const products = [
  { id: "gid://shopify/Product/1", title: "New title" },
  { id: "gid://shopify/Product/2", title: "Another title" },
];
await fs.writeFile(
  "products.jsonl",
  products.map((product) => JSON.stringify({ product })).join("\n"),
);

const { generator } = await bulkify.runBulkMutation(
  `mutation call($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }`,
  "products.jsonl",
);

for await (const result of generator) {
  console.log(result);
}
```

## Typed results

Bulk results don't have the shape of your query. Every node of every
connection becomes its own line, without its nested connections, and nested
nodes get a `__parentId`. `BulkLine<T>` turns a query's result type into
those line types.

If your app uses Shopify's codegen
([`@shopify/api-codegen-preset`](https://www.npmjs.com/package/@shopify/api-codegen-preset)),
add this once, in any `.d.ts` file your project includes:

```ts
import type { AdminQueries } from "@shopify/admin-api-client";

declare module "@kampfire/bulkify" {
  interface BulkifyQueries extends AdminQueries {}
}
```

Then `runBulkQuery` types the lines of any query codegen knows:

```ts
const PRODUCTS = `#graphql
  query BulkProducts {
    products {
      edges { node { id title variants { edges { node { id price } } } } }
    }
  }
`;

const { generator } = await bulkify.runBulkQuery(PRODUCTS);
for await (const line of generator) {
  if (line.__parentId === undefined) {
    line.title; // a product: { id, title }
  } else {
    line.price; // a variant: { id, price, __parentId }
  }
}
```

- Codegen only sees queries that are named and start with `#graphql`, as above.
- The lookup goes by the exact query text, so it doesn't work for queries built
  with `${...}`. Pass the type instead:
  `runBulkQuery<BulkLine<BulkProductsQuery>>(query)`, with the result type
  from codegen. The same works for `streamURL<BulkLine<...>>(url)`.
- When a node has several nested connections, select `__typename` in each to
  tell their lines apart.
- Without the setup, or for a query codegen doesn't know, lines are `unknown`
  unless you pass a type.

## Background jobs

For servers and workers that shouldn't block while an operation runs, start
it, keep its id and come back to it later, for example when the
`bulk_operations/finish` webhook arrives. `streamURL` reads the results
straight from Shopify without writing a file.

```ts
import { BulkifyUserError } from "@kampfire/bulkify";

let id: string;
try {
  ({ id } = await bulkify.startBulkQuery(`{ orders { edges { node { id } } } }`));
  // save the id somewhere
} catch (error) {
  if (error instanceof BulkifyUserError && error.inProgress) {
    // another bulk operation is running, try again later
  }
  throw error;
}

// Later
const operation = await bulkify.getBulkOperation(id);
if (operation?.status === "COMPLETED") {
  for await (const order of bulkify.streamURL(operation.url)) {
    // one parsed line at a time
  }
}

// Or wait in place
const done = await bulkify.waitForBulkOperation(id, { pollingTime: 5000 });
```

## Using your own client

Pass `request` instead of `client` to send Bulkify's GraphQL calls through
your own code. The function gets the query and variables, and should resolve
to the response's `data` and throw on GraphQL errors.

This is useful when your app already has a client that handles Shopify's rate
limits. Bulkify checks on operations every few seconds, and those calls share
the store's rate limit with the rest of your app. Going through your client
means they wait and retry when throttled instead of failing.

```ts
const bulkify = new Bulkify({
  request: (query, variables) => myClient.request(query, { variables }),
  spinner: false,
});
```

## API reference

### `new Bulkify(options)`

| Option        | Description                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `client`      | A Shopify GraphQL client: anything with `request(query, { variables })` that returns `{ data, errors }`.                           |
| `request`     | A function `(query, variables) => Promise<data>`, used instead of `client`. See [Using your own client](#using-your-own-client).    |
| `resultsPath` | Folder where `runBulkQuery`, `runBulkMutation` and `processURL` download results before reading them. Defaults to a `bulkify` folder in the system temp directory. |
| `deleteFiles` | Delete downloaded result files once they've been read. Defaults to `true`.                                                         |
| `spinner`     | Show a terminal spinner while `runBulkQuery` and `runBulkMutation` wait. Defaults to `false`.                                      |
| `debug`       | Log queries and operation details.                                                                                                 |

One of `client` or `request` is required.

### Run and read

- **`runBulkQuery<T>(query, { groupObjects? })`**: starts a bulk query, waits for it and returns `{ generator, bulkOperation }`. `generator` yields one parsed line at a time, typed as `T` when given, or from the query text (see [Typed results](#typed-results)). See [Nested results](#things-to-know) for `groupObjects`.
- **`runBulkMutation<T>(mutation, filePath)`**: uploads the JSONL file at `filePath`, runs the mutation, waits for it and returns `{ generator, bulkOperation }`.

### By id

- **`startBulkQuery(query, { groupObjects? })`**: starts a bulk query and returns `{ id, status }` without waiting.
- **`getBulkOperation(id)`**: the operation's current state, or `null` if Shopify doesn't know it.
- **`waitForBulkOperation(id, { pollingTime?, signal? })`**: checks every `pollingTime` ms (default 2000) until the operation finishes. Resolves with the operation when it completes. Throws `BulkifyOperationError` if it failed, was canceled or expired. `signal` is an `AbortSignal` to stop waiting.
- **`streamURL<T>(url)`**: streams a results file line by line without saving it. Yields nothing when `url` is empty, which is what Shopify returns when there were no results.
- **`cancelBulkOperation(id)`**: cancels an operation.

### Other methods

- **`processURL<T>(url)`**: like `streamURL`, but downloads the file to `resultsPath` first.
- **`uploadBulkJSONL(filePath)`**: uploads a JSONL file for a bulk mutation and returns its `stagedUploadPath`.

### Types

- **`BulkLine<T>`**: the line types of a bulk query, from its result type `T`.
- **`BulkifyQueries`**: query result types by query text, for `runBulkQuery` to look up. Empty until you extend it (see [Typed results](#typed-results)).
- **`BulkQueryLine<Q>`**: the line type `runBulkQuery` gives the query text `Q`.

### Errors

- **`BulkifyUserError`**: Shopify refused to start the operation. `userErrors` holds Shopify's errors, and `inProgress` is `true` when the refusal was because other operations are running (one in progress, or the limit of concurrent operations reached). Try again later.
- **`BulkifyOperationError`**: the operation finished without completing. `operation` holds its final state, including `status` and `errorCode`.

## Things to know

- **Concurrent operations.** From API 2026-01, each app can run up to five bulk operations of each type (queries, mutations) per store at once. Before that it was one.
- **Nested results.** Connections inside a bulk query come back as separate lines, each child with a `__parentId` pointing at its parent. By default the lines can come in **any order**, so a child can arrive before its parent. [`nested-results.ts`](https://github.com/kampfire-dev/bulkify/tree/main/src/examples/nested-results.ts) shows how to put them back together. Passing `{ groupObjects: true }` puts each object's children right after it instead, but Shopify warns that grouping makes operations slower and more likely to time out.
- **No results.** When a query matches nothing, the generator yields nothing.
- **Result links expire.** Download results soon after an operation completes.

## Examples

In [`src/examples`](https://github.com/kampfire-dev/bulkify/tree/main/src/examples):

- [`nested-results.ts`](https://github.com/kampfire-dev/bulkify/tree/main/src/examples/nested-results.ts): reads products with their variants and rebuilds the nesting with `__parentId`
- [`update-prices.ts`](https://github.com/kampfire-dev/bulkify/tree/main/src/examples/update-prices.ts): changes the price of every variant of tagged products, with a bulk query feeding a bulk mutation

To run them against a store, set `SHOPIFY_STORE` and `SHOPIFY_ACCESS_TOKEN` (or
`SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`), then:

```sh
pnpm example:nested sale        # products tagged "sale"
pnpm example:prices sale -10    # 10% off their variants
```

## Shopify docs

- [Bulk queries](https://shopify.dev/docs/api/usage/bulk-operations/queries)
- [Bulk mutations (imports)](https://shopify.dev/docs/api/usage/bulk-operations/imports)
- [`BulkOperation` object](https://shopify.dev/docs/api/admin-graphql/latest/objects/BulkOperation)

## Development

Types for the GraphQL operations in `src/index.ts` (strings marked
`/* graphql */`) are generated from Shopify's Admin schema into
`src/generated/admin.ts`. After changing an operation, or the API version in
`codegen.ts`, run:

```sh
pnpm codegen
```

Other scripts:

- `pnpm test`: unit tests, no store needed
- `pnpm test:store`: runs real bulk operations on a dev store (see below)
- `pnpm codegen:check`: fails if `src/generated` is out of date

CI runs typecheck, tests, build and `codegen:check` on every push and pull
request.

### Releasing

Releases are automated with [Changesets](https://changesets.dev):

1. In a PR that changes the package, run `pnpm changeset`, pick patch, minor or
   major, and write the changelog entry. Commit the file it creates in
   `.changeset/`. A bot comment on each PR shows what it will release.
2. When PRs with changesets are merged, a bot opens or updates a
   **Version Packages** PR that bumps the version in `package.json` and adds
   the entries to `CHANGELOG.md`.
3. Merging the Version Packages PR publishes to npm, pushes the `v<version>`
   tag and creates the GitHub release. Several merged PRs can go out in one
   release.

Publishing uses npm trusted publishing from `.github/workflows/release.yml`, so
there's no npm token. The workflow runs typecheck, tests and build before
packing. `npm publish` still works by hand as a fallback.

### Store test

`pnpm test:store` creates a few draft products on a dev store, reads and
updates them with bulk operations, then deletes them. Use an empty dev store
for it.

1. Link the app in `ci-app/` to a Dev Dashboard app (`shopify app config link`
   from that folder), release its scopes with `shopify app deploy`, and install
   it on the dev store.
2. Run `shopify app env pull` in `ci-app/`. It writes `ci-app/.env` with the
   store and the app's client ID and secret, which the test reads. The test
   gets a fresh access token each run.

The scheduled workflow (`.github/workflows/scheduled.yml`) runs the store test
every Monday and checks Bulkify's queries against the next Shopify API
version. If either fails, it opens an issue. It needs a `shopify-store`
environment in the repo settings with `SHOPIFY_STORE`, `SHOPIFY_API_KEY` and
`SHOPIFY_API_SECRET` secrets, with the values from `ci-app/.env`. Run it by hand from
the Actions tab before publishing.

## Contributing

Issues and pull requests are welcome.

## License

[ISC](LICENSE) © Kampfire.dev Inc.

## Author

Matt Oskamp
