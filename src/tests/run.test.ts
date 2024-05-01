import "dotenv/config";
import "@shopify/shopify-api/adapters/node";
import { expect, test } from "vitest";
import Bulkify from "../index";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";

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

test("run", async () => {
  expect(true).toBe(true);
});

test("create", async () => {
  const session = shopify.session.customAppSession(process.env.SHOP_NAME || "");
  const client = new shopify.clients.Graphql({ session });
  const bulkify = new Bulkify({
    client,
    deleteFiles: false,
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

  const it = await bulkify.runBulkQuery(query);

  for await (const variant of it) {
    console.log(variant);
  }

  // console.log(response);
  // expect(response).toBeDefined();
});
