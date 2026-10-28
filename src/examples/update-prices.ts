// Changes the price of every variant of the products with a tag.
//
// pnpm example:prices [tag] [percent]
// pnpm example:prices sale -10    # 10% off products tagged "sale"
//
// A bulk query reads the variants, then a bulk mutation updates them, one
// productVariantsBulkUpdate call per product.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bulkify } from "./setup.js";

const tag = process.argv[2] ?? "bulkify-example";
const percent = Number(process.argv[3] ?? -10);

type ProductLine = { id: string };
type VariantLine = { id: string; price: string; __parentId: string };

// 1. Read each product's variants
const { generator } = await bulkify.runBulkQuery<ProductLine | VariantLine>(`{
  products(query: "tag:${tag}") {
    edges {
      node {
        id
        variants {
          edges {
            node {
              id
              price
            }
          }
        }
      }
    }
  }
}`);

const variantsByProduct = new Map<string, { id: string; price: string }[]>();
for await (const line of generator) {
  if (!("__parentId" in line)) continue;
  const price = (Number(line.price) * (1 + percent / 100)).toFixed(2);
  const variants = variantsByProduct.get(line.__parentId) ?? [];
  variants.push({ id: line.id, price });
  variantsByProduct.set(line.__parentId, variants);
}

if (variantsByProduct.size === 0) {
  console.log(`No products tagged "${tag}"`);
  process.exit();
}

// 2. Write one line of variables per mutation call
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bulkify-example-"));
const filePath = path.join(dir, "prices.jsonl");
await fs.writeFile(
  filePath,
  [...variantsByProduct]
    .map(([productId, variants]) => JSON.stringify({ productId, variants }))
    .join("\n"),
);

// 3. Run the mutation for every line
type Result = {
  data: {
    productVariantsBulkUpdate: {
      productVariants: { id: string; price: string }[] | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  };
};

const { generator: results } = await bulkify.runBulkMutation<Result>(
  `mutation call($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }`,
  filePath,
);

let updated = 0;
for await (const { data } of results) {
  const { productVariants, userErrors } = data.productVariantsBulkUpdate;
  for (const error of userErrors) console.error(error.message);
  updated += productVariants?.length ?? 0;
}
await fs.rm(dir, { recursive: true });

console.log(`Updated ${updated} variants of ${variantsByProduct.size} products`);
