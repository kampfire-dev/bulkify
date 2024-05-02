# Bulkify

**Bulkify** is a lightweight, efficient Node.js package specifically crafted to manage bulk operations within Shopify stores using Shopify's GraphQL API. It is designed with modern JavaScript and TypeScript in mind, providing strong typing and intelligent autocompletion that enhance developer productivity and code quality.

## Key Features

- **Streaming First**: Uses async generators to stream results, allowing you to process data as it arrives. This is especially useful for large datasets and memory efficiency.
- **Efficient Bulk Operations**: Supports both bulk queries and mutations to handle large datasets efficiently.
- **TypeScript Support**: Fully compatible with TypeScript for enhanced development experience.
- **Lightweight Design**: Minimal dependencies ensure that the package is lightweight and fast.
- **Error Handling**: Robust error handling capabilities to manage and retry failed operations seamlessly.

## Installation

You can install Bulkify using your preferred package manager.

```bash
npm install @kampfire/bulkify
```

## Usage

Here's a quick start guide to using Bulkify in your project:

```javascript
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";
import "dotenv/config";
import Bulkify from "@kampfire/bulkify";

async function run() {
  // Use the standard Shopify API client to create a session
  const shopify = shopifyApi({
    adminApiAccessToken: process.env.API_ACCESS_TOKEN,
    apiVersion: ApiVersion.January24,
    hostName: process.env.SHOP_NAME,
  });

  const session = shopify.session.customAppSession(process.env.SHOP_NAME);
  const client = new shopify.clients.Graphql({ session });
  const bulkify = new Bulkify({
    client,
  });

  // Example of a bulk query
  const query = `
  {
    productVariants(query:"tag:test") {
      edges {
        node {
          id
          sku
          price
        }
      }
    }
  }`;

  const { generator } = await bulkify.runBulkQuery(query);
  for await (const variant of generator) {
    console.log(variant);
  }
}

run();
```

## API Reference

These are the main functions and classes provided by Bulkify, however there are additional functions and classes available for more advanced use cases.

### `Bulkify(options)`

- **options.client**: A configured Shopify GraphQL client instance.
- **options.resultsPath** (optional): The path where results should be stored. Defaults to "./results".
- **options.deleteFiles** (optional): Boolean flag to determine if result files should be deleted after processing. Defaults to `true`.

### `runBulkQuery(query)`

- **query**: The GraphQL query string.
- Returns an async generator yielding query results.

### `runBulkMutation(mutation, filePath)`

- **mutation**: The GraphQL mutation string.
- **filePath**: Path to the JSONL file containing data for mutations.
- Returns an async generator yielding mutation results.

### `processURL(url)`

- Useful for processing a URL returned from a bulk operation (like from a webhook).
- **url**: The URL of the resulting JSONL file.
- Returns an async generator yielding the results of the bulk operation.

## Examples

You can find more examples, such as how to do a bulk query and mutation in a couple lines of code to change prices, in the [examples](https://github.com/kampfire-dev/bulkify/tree/main/examples) directory.

## Gotchas

- **You can only have a single bulk operation of each type running per store / app.**
- **Nested Queries**: When using nested queries, the objects will appear after one another in the returned JSONL. To handle this, you should store the accumulated nested objects in an array and process them once you get to another parent object. See the [examples](https://github.com/kampfire-dev/bulkify/tree/main/examples) for more details.

## Documentation

Check out the official shopify docs on [GraphQL](https://shopify.dev/docs/api/admin-graphql) and [Bulk Operations](https://shopify.dev/docs/api/admin-graphql/2024-04/objects/BulkOperation).

## Contributing

If you're interested in contributing to the development of Bulkify, please submit an issue or pull request. We welcome contributions from the community and appreciate your feedback.

## License

Bulkify is available under the [ISC license](https://github.com/kampfire-dev/bulkify/blob/main/LICENSE).

## Author

Matt Oskamp
