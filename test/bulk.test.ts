import { describe } from "node:test";
import BulkOperations from "../src/index.js";
import { createGraphQLClient } from "@shopify/graphql-client";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

const client = createGraphQLClient({
  url: `https://${process.env.TEST_SHOP}.myshopify.com/admin/api/2021-10/graphql.json`,
  headers: {
    "X-Shopify-Access-Token": process.env.TEST_ACCESS_TOKEN || "",
  },
});

// const shopify = new shopifyApi({})

describe("BulkOperations", () => {
  // it("should create a bulk query", async () => {
  //   const bulk = new BulkOperations({ client as any });
  //   const QUERY = `
  //     products(query: 'title:shirt') {
  //       edges {
  //         node {
  //           id
  //         }
  //       }
  //     }
  //   `;
  //   const result = await bulk.createBulkQuery(QUERY);
  //   console.log(result);
  //   expect(result).toEqual({});
  // });
  // it("should get the bulk query status", async () => {
  //   const bulk = new BulkOperations({ client });
  //   const result = await bulk.getBulkQueryStatus("QUERY");
  //   expect(result).toEqual({});
  // });
});
