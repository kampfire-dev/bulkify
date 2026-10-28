// Type tests for BulkLine and runBulkQuery's line types. They're checked by
// `pnpm typecheck`; at runtime they only make sure the file loads.
import { describe, expectTypeOf, it } from "vitest";
import Bulkify, { type BulkLine } from "../index.js";

// Shaped like Shopify's codegen output, which uses Pick and intersections
type Product = { id: string; title: string; handle: string; vendor: string };
type Variant = { id: string; price: string; sku: string | null };

type ProductsQuery = {
  products: {
    edges: Array<{
      node: Pick<Product, "id" | "title"> & {
        variants: {
          edges: Array<{ node: Pick<Variant, "id" | "price"> }>;
        };
      };
    }>;
  };
};

describe("BulkLine", () => {
  it("splits nested connections into lines with __parentId", () => {
    expectTypeOf<BulkLine<ProductsQuery>>().toEqualTypeOf<
      | { id: string; title: string; __parentId?: undefined }
      | { id: string; price: string; __parentId: string }
    >();
  });

  it("supports the nodes shape and nullable connections", () => {
    type Query = {
      orders: {
        nodes: Array<{
          id: string;
          lineItems: { nodes: Array<{ id: string; quantity: number }> } | null;
        }>;
      } | null;
    };
    expectTypeOf<BulkLine<Query>>().toEqualTypeOf<
      | { id: string; __parentId?: undefined }
      | { id: string; quantity: number; __parentId: string }
    >();
  });

  it("goes several levels deep", () => {
    type Query = {
      customers: {
        edges: Array<{
          node: {
            id: string;
            orders: {
              edges: Array<{
                node: {
                  id: string;
                  lineItems: { edges: Array<{ node: { sku: string | null } }> };
                };
              }>;
            };
          };
        }>;
      };
    };
    expectTypeOf<BulkLine<Query>>().toEqualTypeOf<
      | { id: string; __parentId?: undefined }
      | { id: string; __parentId: string }
      | { sku: string | null; __parentId: string }
    >();
  });

  it("keeps plain objects and lists, and lets __typename tell children apart", () => {
    type Query = {
      products: {
        edges: Array<{
          node: {
            id: string;
            tags: string[];
            seo: { title: string | null };
            variants: {
              edges: Array<{ node: { __typename: "ProductVariant"; id: string } }>;
            };
            media: {
              edges: Array<{ node: { __typename: "MediaImage"; id: string } }>;
            };
          };
        }>;
      };
    };
    type Line = BulkLine<Query>;
    expectTypeOf<Line>().toEqualTypeOf<
      | {
          id: string;
          tags: string[];
          seo: { title: string | null };
          __parentId?: undefined;
        }
      | { __typename: "ProductVariant"; id: string; __parentId: string }
      | { __typename: "MediaImage"; id: string; __parentId: string }
    >();

    const narrow = (line: Line) => {
      if (line.__parentId === undefined) {
        expectTypeOf(line.tags).toEqualTypeOf<string[]>();
      } else if (line.__typename === "MediaImage") {
        expectTypeOf(line).toEqualTypeOf<{
          __typename: "MediaImage";
          id: string;
          __parentId: string;
        }>();
      }
    };
    void narrow;
  });
});

// A query the lookup knows, as Shopify's codegen would register it
const PRODUCTS = `#graphql
  query BulkProducts {
    products {
      edges { node { id title variants { edges { node { id price } } } } }
    }
  }
`;

declare module "../index.js" {
  interface BulkifyQueries {
    // Like Shopify's AdminQueries: unknown queries map to `any`
    [query: string]: { variables: any; return: any };
    [PRODUCTS]: { variables: {}; return: ProductsQuery };
  }
}

describe("runBulkQuery line types", () => {
  // Never called; only type-checked
  const check = async (bulkify: Bulkify) => {
    const looked = await bulkify.runBulkQuery(PRODUCTS);
    for await (const line of looked.generator) {
      expectTypeOf(line).toEqualTypeOf<BulkLine<ProductsQuery>>();
    }

    const unknownQuery = await bulkify.runBulkQuery(`{ shop { id } }`);
    for await (const line of unknownQuery.generator) {
      expectTypeOf(line).toBeUnknown();
    }

    const dynamic = await bulkify.runBulkQuery(String(PRODUCTS));
    for await (const line of dynamic.generator) {
      expectTypeOf(line).toBeUnknown();
    }

    const explicit = await bulkify.runBulkQuery<{ id: string }>(PRODUCTS);
    for await (const line of explicit.generator) {
      expectTypeOf(line).toEqualTypeOf<{ id: string }>();
    }
  };

  it("types lines from the query text, or from an explicit type", () => {
    void check;
  });
});
