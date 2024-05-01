import "dotenv/config";
import "@shopify/shopify-api/adapters/node";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";
import Bulkify from "..";

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
    }
  `;

  const it = bulkify.runBulkQuery(query);

  for await (const variant of it) {
    console.log(variant);
  }
}

run();
