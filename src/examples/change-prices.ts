import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { bulkify } from "./setup.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  // Define the bulk query for fetching product variants and their prices
  const priceQuery = `
  {
    productVariants(query:"tag:test") {
      edges {
        node {
          id
          price
        }
      }
    }
  }`;

  // Execute the bulk query
  const { generator: queryGenerator } = await bulkify.runBulkQuery<{
    id: string;
    price: string;
  }>(priceQuery);

  // Write the updated prices to a JSONL file
  const fs = require("fs");
  const path = require("path");
  const filePath = path.resolve(__dirname, "updated-prices.jsonl");
  const writeStream = fs.createWriteStream(filePath);

  // Collect all variants and increase their price by 10%
  for await (const variant of queryGenerator) {
    const variantInput: {
      id: string;
      price: string;
    } = {
      id: variant.id,
      price: (parseFloat(variant.price) * 1.1).toFixed(2), // Increase price by 10%
    };
    writeStream.write(JSON.stringify({ input: variantInput }) + "\n");
  }

  // Prepare the bulk mutation for updating product variant prices
  const priceUpdateMutation = `
  mutation productVariantUpdate($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }`;

  writeStream.end();

  // Wait for the file write to complete
  await new Promise((resolve) => writeStream.on("close", resolve));

  // Execute the bulk mutation using the prepared JSONL file
  const { generator: mutationGenerator } = await bulkify.runBulkMutation(
    priceUpdateMutation,
    filePath
  );

  // Log the results of the bulk mutation
  for await (const result of mutationGenerator) {
    console.log(result);
  }
}

run();
