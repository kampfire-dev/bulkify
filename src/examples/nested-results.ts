// Reads products with their variants and puts the nesting back together.
//
// pnpm example:nested [tag]
//
// Bulk queries return nested connections as separate lines: each product,
// then its variants, each variant with a __parentId pointing at its product.
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

// Children always come after their parent, so the parent is already here.
// For very large exports, process each product when the next one starts
// instead of keeping them all.
const products = new Map<string, Product>();
for await (const line of generator) {
  if ("__parentId" in line) {
    products.get(line.__parentId)?.variants.push(line);
  } else {
    products.set(line.id, { ...line, variants: [] });
  }
}

for (const product of products.values()) {
  console.log(product.title);
  for (const variant of product.variants) {
    console.log(`  ${variant.title}: ${variant.price}`);
  }
}
console.log(`${products.size} products tagged "${tag}"`);
