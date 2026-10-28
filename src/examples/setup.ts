// Shared setup for the examples.
//
// Set SHOPIFY_STORE and either SHOPIFY_ACCESS_TOKEN, or your app's
// SHOPIFY_API_KEY and SHOPIFY_API_SECRET to get a token with the client
// credentials grant. `shopify app env pull` in ci-app/ writes ci-app/.env,
// which is read here too.
import { createAdminApiClient } from "@shopify/admin-api-client";
import dotenv from "dotenv";
import path from "node:path";
import Bulkify from "../index.js"; // "@kampfire/bulkify" in your project

dotenv.config({
  path: path.resolve(import.meta.dirname, "../../ci-app/.env"),
  quiet: true,
});

const {
  SHOPIFY_STORE,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
} = process.env;

if (!SHOPIFY_STORE) {
  throw new Error("Set SHOPIFY_STORE, e.g. your-store.myshopify.com");
}

async function getAccessToken() {
  if (SHOPIFY_ACCESS_TOKEN) return SHOPIFY_ACCESS_TOKEN;
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    throw new Error(
      "Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_API_KEY and SHOPIFY_API_SECRET",
    );
  }
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Couldn't get an access token (${response.status})`);
  }
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

export const client = createAdminApiClient({
  storeDomain: SHOPIFY_STORE,
  accessToken: await getAccessToken(),
  apiVersion: "2026-10",
});

// The spinner shows progress while operations run
export const bulkify = new Bulkify({ client, spinner: true });
