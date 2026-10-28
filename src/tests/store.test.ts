// Runs Bulkify against a real dev store. Run with `pnpm test:store`.
//
// Reads ci-app/.env, which `shopify app env pull` writes in ci-app/:
// SHOPIFY_STORE, SHOPIFY_API_KEY and SHOPIFY_API_SECRET (the app's client ID
// and secret, used to get a fresh token each run). SHOPIFY_ACCESS_TOKEN, if
// set, is used instead.
//
// The test makes its own data: it creates a few draft products tagged for this
// run, reads and updates them with bulk operations, then deletes them.
// Products left over from a crashed run are deleted first.
import dotenv from "dotenv";
import { createAdminApiClient } from "@shopify/admin-api-client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Bulkify from "../index.js";

dotenv.config({
  path: path.resolve(import.meta.dirname, "../../ci-app/.env"),
  quiet: true,
});

// Keep in step with ADMIN_API_VERSION in codegen.ts
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-10";
const {
  SHOPIFY_STORE,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_ACCESS_TOKEN,
} = process.env;

const CI_TAG = "bulkify-ci";
const RUN_TAG = `bulkify-run-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
const PRODUCT_COUNT = 3;

type Product = { id: string; title: string };

/** A fresh token from the app's client credentials, or the token in .env */
async function getAccessToken() {
  if (SHOPIFY_ACCESS_TOKEN) return SHOPIFY_ACCESS_TOKEN;
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_API_KEY!,
        client_secret: SHOPIFY_API_SECRET!,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Couldn't get an access token (${response.status}): ${await response.text()}`,
    );
  }
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

async function collect<T>(generator: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

async function writeJSONL(lines: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bulkify-store-"));
  const filePath = path.join(dir, "variables.jsonl");
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}

const hasCredentials =
  !!SHOPIFY_STORE &&
  (!!SHOPIFY_ACCESS_TOKEN || (!!SHOPIFY_API_KEY && !!SHOPIFY_API_SECRET));

describe.skipIf(!hasCredentials)("store", () => {
  let client: ReturnType<typeof createAdminApiClient>;
  let bulkify: Bulkify;
  let created: Product[] = [];

  /** A regular (not bulk) GraphQL call */
  async function graphql<T>(query: string, variables?: Record<string, unknown>) {
    const { data, errors } = await client.request<T>(query, { variables });
    if (errors || !data) throw new Error(JSON.stringify(errors));
    return data;
  }

  async function deleteProducts(ids: string[]) {
    for (const id of ids) {
      await graphql(
        `mutation ($id: ID!) { productDelete(input: { id: $id }) { userErrors { message } } }`,
        { id },
      );
    }
  }

  /** Search is updated a little after products change, so wait for it */
  async function waitForSearch(query: string, count: number) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const data = await graphql<{ productsCount: { count: number } }>(
        `query ($query: String!) { productsCount(query: $query) { count } }`,
        { query },
      );
      if (data.productsCount.count === count) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Search never found ${count} products for "${query}"`);
  }

  const productsQuery = (tag: string) => `{
    products(query: "tag:${tag}") {
      edges { node { id title } }
    }
  }`;

  beforeAll(async () => {
    client = createAdminApiClient({
      storeDomain: SHOPIFY_STORE!,
      accessToken: await getAccessToken(),
      apiVersion: API_VERSION,
    });
    bulkify = new Bulkify({ client });

    const leftovers = await graphql<{ products: { nodes: { id: string }[] } }>(
      `{ products(first: 250, query: "tag:${CI_TAG}") { nodes { id } } }`,
    );
    await deleteProducts(leftovers.products.nodes.map(({ id }) => id));
  });

  afterAll(async () => {
    if (client) await deleteProducts(created.map(({ id }) => id));
  });

  it("creates products with a bulk mutation", async () => {
    const filePath = await writeJSONL(
      Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
        product: {
          title: `Bulkify CI ${i + 1}`,
          tags: [CI_TAG, RUN_TAG],
          status: "DRAFT",
        },
      })),
    );

    const { generator } = await bulkify.runBulkMutation<{
      data: {
        productCreate: { product: Product | null; userErrors: { message: string }[] };
      };
    }>(
      `mutation call($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id title }
          userErrors { field message }
        }
      }`,
      filePath,
    );
    const results = await collect(generator);
    await fs.rm(path.dirname(filePath), { recursive: true });

    created = results.flatMap(({ data }) => data.productCreate.product ?? []);
    expect(results.flatMap(({ data }) => data.productCreate.userErrors)).toEqual([]);
    expect(created).toHaveLength(PRODUCT_COUNT);
  });

  it("reads them with a bulk query", async () => {
    await waitForSearch(`tag:${RUN_TAG}`, PRODUCT_COUNT);
    const { generator } = await bulkify.runBulkQuery<Product>(productsQuery(RUN_TAG));
    const ids = (await collect(generator)).map(({ id }) => id).sort();
    expect(ids).toEqual(created.map(({ id }) => id).sort());
  });

  it("starts, waits for and streams a bulk query by id", async () => {
    const { id } = await bulkify.startBulkQuery(productsQuery(RUN_TAG));
    const operation = await bulkify.waitForBulkOperation(id);
    const products = await collect(bulkify.streamURL<Product>(operation.url));
    expect(products).toHaveLength(PRODUCT_COUNT);
  });

  it("updates them with a bulk mutation", async () => {
    const filePath = await writeJSONL(
      created.map(({ id, title }) => ({ product: { id, title: `${title} updated` } })),
    );
    const { generator } = await bulkify.runBulkMutation<{
      data: { productUpdate: { product: Product | null } };
    }>(
      `mutation call($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id title }
          userErrors { field message }
        }
      }`,
      filePath,
    );
    const results = await collect(generator);
    await fs.rm(path.dirname(filePath), { recursive: true });

    const titles = results.map(({ data }) => data.productUpdate.product?.title);
    expect(titles.every((title) => title?.endsWith(" updated"))).toBe(true);
  });

  it("yields nothing when a bulk query matches nothing", async () => {
    const { generator } = await bulkify.runBulkQuery(productsQuery(`${RUN_TAG}-none`));
    expect(await collect(generator)).toEqual([]);
  });
});
