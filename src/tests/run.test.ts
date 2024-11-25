import "dotenv/config";
import "@shopify/shopify-api/adapters/node";
import { expect, test } from "vitest";
import Bulkify from "../index.js";
import { createAdminApiClient } from "@shopify/admin-api-client";

const client = createAdminApiClient({
  accessToken: process.env.API_ACCESS_TOKEN || "",
  storeDomain: process.env.SHOP_NAME || "",
  apiVersion: "2024-07",
});

test("run", async () => {
  expect(true).toBe(true);
});

test("create", async () => {
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

  const { generator: it } = await bulkify.runBulkQuery(query);

  for await (const variant of it) {
    console.log(variant);
  }

  // console.log(response);
  // expect(response).toBeDefined();
});
