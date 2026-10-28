// Reads products with their variants and puts the nesting back together.
//
// pnpm example:nested [tag]
//
// Bulk queries return nested connections as separate lines: products, and
// variants with a __parentId pointing at their product. The lines can come in
// any order, so a variant may arrive before its product.
import { bulkify } from "./setup.js";

const tag = process.argv[2] ?? "bulkify-example";

type ProductLine = { id: string; title: string };
type VariantLine = {
  id: string;
  title: string;
  price: string;
  __parentId: string;
};
type Product = ProductLine & { variants: VariantLine[] };

const { generator } = await bulkify.runBulkQuery<ProductLine | VariantLine>(`{
  products(query: "tag:${tag}") {
    edges {
      node {
        id
        title
        variants {
          edges {
            node {
              id
              title
              price
            }
          }
        }
      }
    }
  }
}`);

const products = new Map<string, Product>();
// Variants whose product hasn't arrived yet
const waiting = new Map<string, VariantLine[]>();

for await (const line of generator) {
  if ("__parentId" in line) {
    const product = products.get(line.__parentId);
    if (product) {
      product.variants.push(line);
    } else {
      waiting.set(line.__parentId, [...(waiting.get(line.__parentId) ?? []), line]);
    }
  } else {
    products.set(line.id, { ...line, variants: waiting.get(line.id) ?? [] });
    waiting.delete(line.id);
  }
}

// With runBulkQuery(query, { groupObjects: true }), each product's variants
// come right after it instead, so you can handle each product as soon as the
// next one starts. Shopify warns that grouping is slower and more likely to
// time out.

for (const product of products.values()) {
  console.log(product.title);
  for (const variant of product.variants) {
    console.log(`  ${variant.title}: ${variant.price}`);
  }
}
console.log(`${products.size} products tagged "${tag}"`);
