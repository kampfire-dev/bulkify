import { describe, expect, it, vi } from "vitest";
import Bulkify, {
  BulkifyOperationError,
  BulkifyUserError,
  GET_BULK_OPERATION,
  RUN_BULK_QUERY,
} from "../index.js";

function withRequest(responses: unknown[]) {
  const request = vi.fn(async (..._args: unknown[]) => responses.shift() as any);
  return { request, bulkify: new Bulkify({ request, spinner: false }) };
}

describe("startBulkQuery", () => {
  it("sends the query as a variable and returns the operation", async () => {
    const { request, bulkify } = withRequest([
      {
        bulkOperationRunQuery: {
          bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" },
          userErrors: [],
        },
      },
    ]);
    const query = `{ orders(query: "tag:'x'") { edges { node { id } } } }`;

    await expect(bulkify.startBulkQuery(query)).resolves.toEqual({
      id: "gid://shopify/BulkOperation/1",
      status: "CREATED",
    });
    expect(request).toHaveBeenCalledWith(RUN_BULK_QUERY, {
      query,
      groupObjects: null,
    });
  });

  it("throws user errors, and says when another operation is running", async () => {
    const { bulkify } = withRequest([
      {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ code: "OPERATION_IN_PROGRESS", message: "Busy" }],
        },
      },
    ]);
    const error = await bulkify.startBulkQuery("{ shop { id } }").catch((e) => e);
    expect(error).toBeInstanceOf(BulkifyUserError);
    expect(error.inProgress).toBe(true);
    expect(error.message).toBe("Busy");
  });
});

describe("getBulkOperation and waitForBulkOperation", () => {
  it("looks the operation up by id", async () => {
    const { request, bulkify } = withRequest([
      { bulkOperation: { id: "op", status: "RUNNING" } },
    ]);
    await expect(bulkify.getBulkOperation("op")).resolves.toEqual({
      id: "op",
      status: "RUNNING",
    });
    expect(request).toHaveBeenCalledWith(GET_BULK_OPERATION, { id: "op" });
  });

  it("polls until completed", async () => {
    const { request, bulkify } = withRequest([
      { bulkOperation: { id: "op", status: "CREATED" } },
      { bulkOperation: { id: "op", status: "RUNNING" } },
      { bulkOperation: { id: "op", status: "COMPLETED", url: "https://x" } },
    ]);
    const operation = await bulkify.waitForBulkOperation("op", { pollingTime: 1 });
    expect(operation.url).toBe("https://x");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("throws when the operation fails", async () => {
    const { bulkify } = withRequest([
      { bulkOperation: { id: "op", status: "FAILED", errorCode: "TIMEOUT" } },
    ]);
    const error = await bulkify.waitForBulkOperation("op").catch((e) => e);
    expect(error).toBeInstanceOf(BulkifyOperationError);
    expect(error.message).toBe("Bulk operation failed (TIMEOUT)");
  });
});

describe("streamURL", () => {
  it("parses each line without writing a file", async () => {
    const body = '{"id":"1"}\n{"id":"2","__parentId":"1"}\n';
    const fetchFn = vi.fn(async () => new Response(body));
    const { bulkify } = withRequest([]);

    const lines = [];
    for await (const line of bulkify.streamURL("https://x", fetchFn as any)) {
      lines.push(line);
    }
    expect(lines).toEqual([{ id: "1" }, { id: "2", __parentId: "1" }]);
  });

  it("yields nothing when Shopify returned no URL", async () => {
    const fetchFn = vi.fn();
    const { bulkify } = withRequest([]);
    const lines = [];
    for await (const line of bulkify.streamURL(null, fetchFn as any)) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("clients", () => {
  it("still accepts a Shopify GraphQL client", async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bulkOperation: { id: "op", status: "RUNNING" } },
      })),
    };
    const bulkify = new Bulkify({ client, spinner: false });
    await expect(bulkify.getBulkOperation("op")).resolves.toMatchObject({
      status: "RUNNING",
    });
    expect(client.request).toHaveBeenCalledWith(GET_BULK_OPERATION, {
      variables: { id: "op" },
    });
  });

  it("throws GraphQL errors from a client", async () => {
    const client = {
      request: vi.fn(async () => ({ errors: [{ message: "Access denied" }] })),
    };
    const bulkify = new Bulkify({ client, spinner: false });
    await expect(bulkify.getBulkOperation("op")).rejects.toThrow(/Access denied/);
  });

  it("needs a client or a request function", () => {
    expect(() => new Bulkify({})).toThrow();
  });
});
