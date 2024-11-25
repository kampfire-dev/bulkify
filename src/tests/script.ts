import "dotenv/config";
import { createWriteStream } from "fs";
import { access, mkdir } from "fs/promises";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import Bulkify from "../index.js";
import { createAdminApiClient } from "@shopify/admin-api-client";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const client = createAdminApiClient({
  accessToken: process.env.API_ACCESS_TOKEN || "",
  storeDomain: process.env.SHOP_NAME || "",
  apiVersion: "2024-07",
});

async function run() {
  const bulkify = new Bulkify({
    client,
    deleteFiles: true,
  });

  const filePath = path.resolve(__dirname, "../../../../samples/price-changes");

  try {
    await access(filePath);
  } catch (error) {
    await mkdir(filePath, { recursive: true });
  }

  const fileName = path.join(filePath, "price-changes.jsonl");
  const writeStream = createWriteStream(fileName);

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

  const { generator: it } = await bulkify.runBulkQuery(query);

  for await (const variant of it) {
    const input: any = {
      input: variant,
    };
    writeStream.write(JSON.stringify(input) + "\n");
    console.log(variant);
  }

  writeStream.end();

  const UPDATE_VARIANTS = `mutation call($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        sku
        id
      }
      userErrors {
        message
        field
      }
    }
  }`;

  return new Promise<void>((resolve) => {
    writeStream.on("close", async () => {
      const { generator: it } = await bulkify.runBulkMutation<any>(
        UPDATE_VARIANTS,
        fileName
      );
      for await (const result of it) {
        console.log(result);
      }
      resolve();
    });
  });
}

run();
