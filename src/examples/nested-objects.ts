import { bulkify } from "./setup.js";

// get your types anyway you want
interface ProductVariant {
  __typename: "ProductVariant";
  id: string;
  sku: string;
  title: string;
  product: {
    hasOnlyDefaultVariant: boolean;
    vendor: string;
    title: string;
    tags: string[];
    images: {
      edges: {
        node: Image;
      }[];
    };
  };
  image?: Image;
}

interface Image {
  __typename: "Image";
  url: string;
}

// Type guard to determine if the item is a ProductVariant
function isProductVariant(item: any): item is ProductVariant {
  return item.__typename === "ProductVariant";
}

// Type guard to determine if the item is an Image
function isImage(item: any): item is Image {
  return item.__typename === "Image";
}

async function bulkProcessProductVariants(productQuery: string) {
  const BULK_PRODUCT_VARIANT_QUERY = `{
    productVariants(query: "${productQuery}") {
      edges {
        node {
          __typename
          id
          sku
          title
          product {
            hasOnlyDefaultVariant
            vendor
            tags
            title
            images {
              edges {
                node {
                  __typename
                  url
                }
              } 
            }
          }
          image {
            url
          }
        }
      }
    }
  }`;

  // Run the bulk query
  const { generator: iterator } = await bulkify.runBulkQuery<
    ProductVariant | Image
  >(BULK_PRODUCT_VARIANT_QUERY);

  // the stream of json objects will come in as;
  // ProductVariant
  // Image
  // Image
  // Image
  // ProductVariant
  // Image
  // ...

  // So we need to process the previous ProductVariant when we encounter a new one and after we have collected all the images

  let images: Image[] = [];
  let previousProductVariant: ProductVariant | null = null;

  function processPV() {
    if (previousProductVariant === null) {
      return;
    }
    console.log(`Product Variant: ${previousProductVariant.sku}`);
    console.log(`Product Title: ${previousProductVariant.product.title}`);
    console.log(`Vendor: ${previousProductVariant.product.vendor}`);
    if (previousProductVariant.image) {
      console.log(`Variant Image URL: ${previousProductVariant.image.url}`);
    }
    for (const image of images) {
      console.log(`Nested Product Image URL: ${image.url}`);
    }
    images = [];
  }

  for await (const item of iterator) {
    if (isImage(item)) {
      images.push(item);
    } else if (isProductVariant(item)) {
      processPV();
      previousProductVariant = item;
    }
  }

  // Process the last product variant
  processPV();
  images = [];
}

// Example usage with Shopify GraphQL client initialization
bulkProcessProductVariants("tag:test");
