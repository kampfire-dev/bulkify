import { ApiVersion, shopifyApi } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import "dotenv/config";
import { createWriteStream } from "fs";
import { access, mkdir } from "fs/promises";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import Bulkify from "..";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const shopify = shopifyApi({
  adminApiAccessToken: process.env.API_ACCESS_TOKEN,
  privateAppStorefrontAccessToken: process.env.API_ACCESS_TOKEN,
  apiKey: process.env.API_KEY || "",
  apiSecretKey: process.env.API_SECRET_KEY || "",
  apiVersion: ApiVersion.January24,
  hostName: process.env.SHOP_NAME || "",
  scopes: [],
  isEmbeddedApp: false,
  isCustomStoreApp: true,
});

async function run() {
  const session = shopify.session.customAppSession(process.env.SHOP_NAME || "");
  const client = new shopify.clients.Graphql({ session });
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

  const it = await bulkify.runBulkQuery(query);

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

  writeStream.on("close", async () => {
    const it = await bulkify.runBulkMutation<any>(UPDATE_VARIANTS, fileName);
    for await (const result of it) {
      console.log(result);
    }
  });
}

run();
