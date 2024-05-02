import "dotenv/config";
import "@shopify/shopify-api/adapters/node";
import { LATEST_API_VERSION, shopifyApi } from "@shopify/shopify-api";
import Bulkify from "../index.js";

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
const client = new shopify.clients.Graphql({ session });

export const bulkify = new Bulkify({
  client,
  deleteFiles: true,
});
