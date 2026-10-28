// Reads products with their variants and puts the nesting back together.
//
// pnpm example:nested [tag]
//
// Bulk queries return nested connections as separate lines: products, and
// variants with a __parentId pointing at their product. The lines can come in
// any order, so a variant may arrive before its product.
import type { BulkLine } from "../index.js"; // "@kampfire/bulkify"
import { bulkify } from "./setup.js";

const tag = process.argv[2] ?? "bulkify-example";

// The query's result type. In an app, Shopify's codegen generates this, and
// for a query without ${...} the lines are typed automatically (see the
// README's "Typed results").
type ProductsQuery = {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        variants: {
          edges: Array<{ node: { id: string; title: string; price: string } }>;
        };
      };
    }>;
  };
};

// Product lines, and variant lines with a __parentId
type Line = BulkLine<ProductsQuery>;
type VariantLine = Extract<Line, { __parentId: string }>;
type Product = Exclude<Line, VariantLine> & { variants: VariantLine[] };

const { generator } = await bulkify.runBulkQuery<Line>(`{
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
  if (line.__parentId !== undefined) {
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
