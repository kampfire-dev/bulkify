import "dotenv/config";
import "@shopify/shopify-api/adapters/node";
import { LATEST_API_VERSION, shopifyApi } from "@shopify/shopify-api";
import Bulkify from "../index.js";
import { createAdminApiClient } from "@shopify/admin-api-client";

// Initialize the Shopify API client
const shopify = shopifyApi({
  adminApiAccessToken: process.env.API_ACCESS_TOKEN,
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true,
  isEmbeddedApp: false,
  hostName: process.env.SHOP_NAME || "",
  apiSecretKey: process.env.API_SECRET_KEY || "",
});

const session = shopify.session.customAppSession(process.env.SHOP_NAME || "");
// const client = new shopify.clients.Graphql({ session });

// Or you can use the admin api client
const client = createAdminApiClient({
  accessToken: process.env.API_ACCESS_TOKEN || "",
  storeDomain: process.env.SHOP_NAME || "",
  apiVersion: "2024-07",
});

export const bulkify = new Bulkify({
  client,
  deleteFiles: true,
});
