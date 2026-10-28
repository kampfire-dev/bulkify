import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Bulkify, {
  BulkifyOperationError,
  BulkifyUserError,
  GET_BULK_OPERATION,
  RUN_BULK_MUTATION,
  RUN_BULK_QUERY,
  STAGED_UPLOADS_CREATE,
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
    expect(request).toHaveBeenCalledWith(RUN_BULK_QUERY, { query });
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

  it("counts the concurrent operations limit as in progress", async () => {
    const { bulkify } = withRequest([
      {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ code: "LIMIT_REACHED", message: "Limit reached" }],
        },
      },
    ]);
    const error = await bulkify.startBulkQuery("{ shop { id } }").catch((e) => e);
    expect(error.inProgress).toBe(true);
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

describe("runBulkQuery and runBulkMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const started = (key: string) => ({
    [key]: { bulkOperation: { id: "mine", status: "CREATED" }, userErrors: [] },
  });
  const completed = {
    bulkOperation: {
      id: "mine",
      status: "COMPLETED",
      objectCount: "2",
      url: "https://results",
    },
  };

  async function collect<T>(generator: AsyncGenerator<T>) {
    const items = [];
    for await (const item of generator) items.push(item);
    return items;
  }

  it("waits on the operation it started, by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"id":"1"}\n{"id":"2"}\n')),
    );
    const { request, bulkify } = withRequest([
      started("bulkOperationRunQuery"),
      completed,
    ]);
    const query = `{ products(query: "title:\\"a\\"") { edges { node { id } } } }`;

    const { generator, bulkOperation } = await bulkify.runBulkQuery(query);

    expect(bulkOperation.id).toBe("mine");
    expect(await collect(generator)).toEqual([{ id: "1" }, { id: "2" }]);
    expect(request).toHaveBeenNthCalledWith(1, RUN_BULK_QUERY, { query });
    expect(request).toHaveBeenNthCalledWith(2, GET_BULK_OPERATION, { id: "mine" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("throws Shopify's user errors", async () => {
    const { bulkify } = withRequest([
      {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ code: "INVALID", field: ["query"], message: "Bad query" }],
        },
      },
    ]);
    const error = await bulkify.runBulkQuery("{ x }").catch((e) => e);
    expect(error).toBeInstanceOf(BulkifyUserError);
    expect(error.message).toBe("Bad query");
  });

  it("yields nothing when the query matched nothing", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const { bulkify } = withRequest([
      started("bulkOperationRunQuery"),
      { bulkOperation: { id: "mine", status: "COMPLETED", objectCount: "0", url: null } },
    ]);
    const { generator } = await bulkify.runBulkQuery("{ x }");
    expect(await collect(generator)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the results can't be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Expired", { status: 403 })));
    const { bulkify } = withRequest([started("bulkOperationRunQuery"), completed]);
    const { generator } = await bulkify.runBulkQuery("{ x }");
    await expect(collect(generator)).rejects.toThrow("Couldn't download results (403)");
  });

  it("uploads the file and runs the mutation with the upload key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bulkify-test-"));
    const filePath = path.join(dir, "vars.jsonl");
    await fs.writeFile(filePath, '{"input":{"id":"1"}}\n');
    const fetchFn = vi.fn(async (url: string) =>
      url === "https://upload"
        ? new Response(null, { status: 201 })
        : new Response('{"id":"1"}\n'),
    );
    vi.stubGlobal("fetch", fetchFn);
    const { request, bulkify } = withRequest([
      {
        stagedUploadsCreate: {
          userErrors: [],
          stagedTargets: [
            {
              url: "https://upload",
              resourceUrl: null,
              parameters: [
                { name: "key", value: "tmp/bulk/vars" },
                { name: "policy", value: "p" },
              ],
            },
          ],
        },
      },
      started("bulkOperationRunMutation"),
      completed,
    ]);
    // Several lines and quotes, which the old inline string couldn't hold
    const mutation = `mutation call($input: ProductInput!) {
      productUpdate(input: $input) { product { title(format: "x") } }
    }`;

    const { generator } = await bulkify.runBulkMutation(mutation, filePath);

    expect(await collect(generator)).toEqual([{ id: "1" }]);
    expect(request).toHaveBeenNthCalledWith(1, STAGED_UPLOADS_CREATE, {
      input: [expect.objectContaining({ filename: "vars.jsonl" })],
    });
    expect(request).toHaveBeenNthCalledWith(2, RUN_BULK_MUTATION, {
      mutation,
      stagedUploadPath: "tmp/bulk/vars",
    });
    expect(request).toHaveBeenNthCalledWith(3, GET_BULK_OPERATION, { id: "mine" });
    await fs.rm(dir, { recursive: true });
  });

  it("puts result files in the system temp folder by default", () => {
    const { bulkify } = withRequest([]);
    expect(bulkify.resultsPath).toBe(path.join(os.tmpdir(), "bulkify"));
  });
});
