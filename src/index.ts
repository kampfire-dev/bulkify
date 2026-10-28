import { randomUUID } from "node:crypto";
import fs, { createReadStream } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { blob } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import ora, { type Ora } from "ora";
import type {
  BulkifyCancelOperationMutation,
  BulkifyCancelOperationMutationVariables,
  BulkifyOperationQuery,
  BulkifyOperationQueryVariables,
  BulkifyRunMutationMutation,
  BulkifyRunMutationMutationVariables,
  BulkifyRunQueryMutation,
  BulkifyRunQueryMutationVariables,
  BulkOperationStatus,
  BulkifyStagedUploadsCreateMutation,
  BulkifyStagedUploadsCreateMutationVariables,
} from "./generated/admin.js";
import { wait } from "./utils/index.js";

export type { BulkOperationStatus };


/** The response shape of Shopify's GraphQL clients */
export type ClientResponse<T> = {
  data?: T;
  errors?: unknown;
};

/**
 * Anything with Shopify's `request(query, { variables })` method, such as
 * `GraphqlClient` from @shopify/shopify-api or `createAdminApiClient`.
 */
export type GraphqlRequestClient = {
  request<T = any>(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<ClientResponse<T>>;
};

/**
 * A plain request function that resolves to `data` and throws on GraphQL
 * errors. Use it to run bulk operations through your own client, for example
 * one that handles throttling.
 */
export type BulkifyRequest = <T = any>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface BulkifyOptions {
  client?: GraphqlRequestClient;
  /** Used instead of `client` when given */
  request?: BulkifyRequest;
  resultsPath?: string;
  deleteFiles?: boolean;
  debug?: boolean;
  /** Show a terminal spinner while waiting. Off by default */
  spinner?: boolean;
}

export type BulkQueryOptions = {
  /**
   * Put each object's children directly after it in the results. Off by
   * default, when lines can come in any order. Shopify warns that grouping
   * makes operations slower and more likely to time out.
   */
  groupObjects?: boolean;
};

/** Variables for RUN_BULK_QUERY. Shopify rejects an explicit null groupObjects */
function bulkQueryVariables(
  query: string,
  { groupObjects }: BulkQueryOptions = {},
): BulkifyRunQueryMutationVariables {
  return groupObjects === undefined ? { query } : { query, groupObjects };
}

export type BulkOperation = {
  id: string;
  status: BulkOperationStatus;
  errorCode?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  objectCount?: string | number | null;
  fileSize?: string | number | null;
  url?: string | null;
  partialDataUrl?: string | null;
};

export type BulkUserError = {
  field?: string[] | string | null;
  message: string;
  code?: string | null;
};

/** Shopify refused to start the operation */
export class BulkifyUserError extends Error {
  constructor(public userErrors: BulkUserError[]) {
    super(userErrors.map((error) => error.message).join("; "));
    this.name = "BulkifyUserError";
  }

  /**
   * True when Shopify refused because other bulk operations are running: one
   * already in progress, or the store's limit of concurrent operations reached
   */
  get inProgress() {
    return this.userErrors.some(
      (error) =>
        error.code === "OPERATION_IN_PROGRESS" || error.code === "LIMIT_REACHED",
    );
  }
}

/** The operation finished without completing */
export class BulkifyOperationError extends Error {
  constructor(public operation: BulkOperation) {
    super(
      `Bulk operation ${operation.status.toLowerCase()}${operation.errorCode ? ` (${operation.errorCode})` : ""}`,
    );
    this.name = "BulkifyOperationError";
  }
}

export const RUN_BULK_QUERY = /* graphql */ `
  mutation BulkifyRunQuery($query: String!, $groupObjects: Boolean! = false) {
    bulkOperationRunQuery(query: $query, groupObjects: $groupObjects) {
      bulkOperation {
        id
        status
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export const RUN_BULK_MUTATION = /* graphql */ `
  mutation BulkifyRunMutation($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(
      mutation: $mutation
      stagedUploadPath: $stagedUploadPath
    ) {
      bulkOperation {
        id
        status
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export const GET_BULK_OPERATION = /* graphql */ `
  query BulkifyOperation($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }
`;

/** Creates a staged upload target for a bulk mutation's JSONL file */
export const STAGED_UPLOADS_CREATE = /* graphql */ `
  mutation BulkifyStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      userErrors {
        field
        message
      }
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
    }
  }
`;

const FINISHED: BulkOperationStatus[] = [
  "CANCELED",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
];

async function* noResults<T>(): AsyncGenerator<T> {}

export default class Bulkify {
  client?: GraphqlRequestClient;
  resultsPath: string;
  private requestFn?: BulkifyRequest;
  private deleteFiles: boolean;
  private debug?: boolean;
  private spinner: boolean;

  constructor(options: BulkifyOptions) {
    if (!options.client && !options.request) {
      throw new Error("Bulkify needs a client or a request function");
    }
    this.client = options.client;
    this.requestFn = options.request;
    this.resultsPath =
      options.resultsPath || path.join(os.tmpdir(), "bulkify");
    this.deleteFiles =
      options.deleteFiles === undefined ? true : options.deleteFiles;
    this.debug = options.debug;
    this.spinner = options.spinner ?? false;
  }

  /** Sends one operation through whichever client was given */
  private async run<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<ClientResponse<T>> {
    if (this.requestFn) {
      return { data: await this.requestFn<T>(query, variables) };
    }
    return this.client!.request<T>(
      query,
      variables ? { variables } : undefined,
    );
  }

  /** Runs an operation and returns `data`, throwing on GraphQL errors */
  private async data<T, V extends Record<string, unknown>>(
    query: string,
    variables?: V,
  ) {
    const { data, errors } = await this.run<T>(query, variables);
    if (errors && (!Array.isArray(errors) || errors.length > 0)) {
      throw new Error(`GraphQL error: ${JSON.stringify(errors)}`);
    }
    if (!data) {
      throw new Error("No data returned");
    }
    return data;
  }

  // Operations by id. These work while several operations run on one store.

  /** Starts a bulk query and returns the operation. Doesn't wait for it */
  async startBulkQuery(
    query: string,
    options: BulkQueryOptions = {},
  ): Promise<{ id: string; status: BulkOperationStatus }> {
    if (this.debug) console.log(query);
    const data = await this.data<
      BulkifyRunQueryMutation,
      BulkifyRunQueryMutationVariables
    >(RUN_BULK_QUERY, bulkQueryVariables(query, options));
    return this.startedOperation(data.bulkOperationRunQuery, "Bulk query");
  }

  /** The operation a run mutation started. Throws on user errors */
  private startedOperation(
    payload:
      | {
          bulkOperation: { id: string; status: BulkOperationStatus } | null;
          userErrors: BulkUserError[];
        }
      | null
      | undefined,
    what: string,
    errors?: unknown,
  ) {
    if (!payload) {
      throw new Error(
        `${what} not created${errors ? `: ${JSON.stringify(errors)}` : ""}`,
      );
    }
    const { bulkOperation, userErrors } = payload;
    if (userErrors.length > 0 || !bulkOperation) {
      throw new BulkifyUserError(
        userErrors.length > 0
          ? userErrors
          : [{ message: "No bulk operation was returned" }],
      );
    }
    return bulkOperation;
  }

  /** The operation's current state, or null if Shopify doesn't know it */
  async getBulkOperation(id: string): Promise<BulkOperation | null> {
    const data = await this.data<
      BulkifyOperationQuery,
      BulkifyOperationQueryVariables
    >(GET_BULK_OPERATION, { id });
    return data.bulkOperation;
  }

  /**
   * Polls until the operation finishes. Resolves with it when completed and
   * throws BulkifyOperationError when it failed, was cancelled or expired.
   */
  async waitForBulkOperation(
    id: string,
    {
      pollingTime = 2000,
      signal,
    }: { pollingTime?: number; signal?: AbortSignal } = {},
  ): Promise<BulkOperation> {
    return this.pollOperation(id, pollingTime, signal);
  }

  private async pollOperation(
    id: string,
    pollingTime: number,
    signal?: AbortSignal,
    onPoll?: (operation: BulkOperation) => void,
  ): Promise<BulkOperation> {
    for (;;) {
      signal?.throwIfAborted();
      const operation = await this.getBulkOperation(id);
      if (!operation) {
        throw new Error(`Bulk operation ${id} not found`);
      }
      onPoll?.(operation);
      if (operation.status === "COMPLETED") return operation;
      if (FINISHED.includes(operation.status)) {
        throw new BulkifyOperationError(operation);
      }
      await wait(pollingTime);
    }
  }

  /**
   * Streams a results file line by line without saving it to disk. Each line
   * is parsed as JSON. Shopify returns no URL when there were no results, so
   * a missing URL yields nothing.
   */
  async *streamURL<T>(
    url: string | null | undefined,
    fetchFn: typeof fetch = fetch,
  ): AsyncGenerator<T> {
    if (!url) return;
    const response = await fetchFn(url);
    if (!response.ok || !response.body) {
      throw new Error(`Couldn't download results (${response.status})`);
    }
    const lines = createInterface({
      input: stream.Readable.fromWeb(response.body as any),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line) yield JSON.parse(line) as T;
    }
  }

  // The original API, unchanged

  async createBulkQuery(
    query: string,
    options: BulkQueryOptions = {},
  ): Promise<ClientResponse<BulkifyRunQueryMutation>> {
    if (this.debug) console.log(query);
    return this.run<BulkifyRunQueryMutation>(
      RUN_BULK_QUERY,
      bulkQueryVariables(query, options),
    );
  }

  async createBulkMutation(
    mutation: string,
    stagedUploadPath: string,
  ): Promise<ClientResponse<BulkifyRunMutationMutation>> {
    if (this.debug) console.log(mutation);
    const variables: BulkifyRunMutationMutationVariables = {
      mutation,
      stagedUploadPath,
    };
    return this.run<BulkifyRunMutationMutation>(RUN_BULK_MUTATION, variables);
  }

  async cancelBulkOperation(id: string) {
    const CANCEL_BULK_OPERATION = /* graphql */ `
      mutation BulkifyCancelOperation($id: ID!) {
        bulkOperationCancel(id: $id) {
          bulkOperation {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables: BulkifyCancelOperationMutationVariables = { id };
    return this.run<BulkifyCancelOperationMutation>(
      CANCEL_BULK_OPERATION,
      variables,
    );
  }

  private startSpinner(text: string): Ora | undefined {
    return this.spinner ? ora(text).start() : undefined;
  }

  private async checkPath() {
    try {
      await fsPromises.access(this.resultsPath);
    } catch (err) {
      await fsPromises.mkdir(this.resultsPath, { recursive: true });
    }
  }

  private async writeResultsToFile(url: string) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Couldn't download results (${res.status})`);
    }

    await this.checkPath();
    const fileName = path.join(
      this.resultsPath,
      `bulk-operation-${Date.now()}-${randomUUID()}.jsonl`,
    );
    await pipeline(
      stream.Readable.fromWeb(res.body as any),
      fs.createWriteStream(fileName),
    );
    return fileName;
  }

  async *processURL<T>(url: string) {
    const rl = await this.getInterfaceFromURL(url);
    for await (const line of rl) {
      const obj = JSON.parse(line) as T;
      yield obj;
    }
  }

  private async getInterfaceFromURL(jsonURL: string) {
    const file = await this.writeResultsToFile(jsonURL);
    if (this.debug) console.log(`Bulk operation results written to: ${file}`);

    const readStream = createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    rl.addListener("close", () => {
      if (this.deleteFiles) {
        fs.unlink(file, (err) => {
          if (err) {
            console.error("Error deleting file", err);
          }
        });
      }
    });

    return rl;
  }

  /** Reads a finished operation's results. Shopify gives no URL when there were none */
  private readResults<T>(operation: BulkOperation): AsyncGenerator<T> {
    if (this.debug) {
      console.log("Bulk objects found:", operation.objectCount);
      console.log("JSON URL:", operation.url);
    }
    return operation.url ? this.processURL<T>(operation.url) : noResults<T>();
  }

  /** Waits for the operation with this id, then reads its results */
  private async readOperation<T>(id: string, pollingTime = 2000) {
    const spinner = this.startSpinner("Polling bulk operation");
    let operation: BulkOperation;
    try {
      operation = await this.pollOperation(id, pollingTime, undefined, (op) => {
        if (spinner) spinner.text = `Polling bulk operation: ${op.status}`;
        if (this.debug) console.log(op);
      });
    } catch (error) {
      spinner?.fail("Bulk operation failed");
      throw error;
    }
    spinner?.succeed("Bulk operation completed");
    return this.readResults<T>(operation);
  }

  private async rawBulkQuery<T>(query: string, options?: BulkQueryOptions) {
    const { data, errors } = await this.createBulkQuery(query, options);
    const bulkOperation = this.startedOperation(
      data?.bulkOperationRunQuery,
      "Bulk query",
      errors,
    );
    const generator = await this.readOperation<T>(bulkOperation.id);
    return { generator, bulkOperation };
  }

  private async bulkMutation(mutation: string, filePath: string) {
    const key = await this.uploadBulkJSONL(filePath);
    if (this.debug) console.log("Bulk mutation key:", key);
    const { data, errors } = await this.createBulkMutation(mutation, key);
    return this.startedOperation(
      data?.bulkOperationRunMutation,
      "Bulk mutation",
      errors,
    );
  }

  private async rawBulkMutation<T>(mutation: string, filePath: string) {
    const bulkOperation = await this.bulkMutation(mutation, filePath);
    const generator = await this.readOperation<T>(bulkOperation.id);
    return { generator, bulkOperation };
  }

  runBulkQuery<T>(query: string, options?: BulkQueryOptions) {
    return this.rawBulkQuery<T>(query, options);
  }

  runBulkMutation<T>(mutation: string, filePath: string) {
    return this.rawBulkMutation<T>(mutation, filePath);
  }

  async uploadBulkJSONL(filePath: string) {
    const fileName = path.basename(filePath);
    const variables: BulkifyStagedUploadsCreateMutationVariables = {
      input: [
        {
          resource: "BULK_MUTATION_VARIABLES",
          filename: fileName,
          mimeType: "text/jsonl",
          httpMethod: "POST",
        },
      ],
    };

    const response = await this.run<BulkifyStagedUploadsCreateMutation>(
      STAGED_UPLOADS_CREATE,
      variables,
    );

    if (!response.data?.stagedUploadsCreate) {
      throw new Error("No data found in response");
    }

    const { userErrors, stagedTargets } = response.data.stagedUploadsCreate;

    if (userErrors.length > 0) {
      throw new BulkifyUserError(userErrors);
    }

    const target = stagedTargets?.[0];

    if (!target?.url) {
      throw new Error("No target found");
    }
    const { url, parameters } = target;
    // Shopify's docs use the `key` parameter as the bulk mutation's
    // stagedUploadPath
    const key = parameters.find((param) => param.name === "key")?.value;
    if (!key) {
      throw new Error("No key found in the staged upload parameters");
    }

    const formData = new FormData();
    for (const param of parameters) {
      formData.append(param.name, param.value);
    }
    const fileStream = fs.createReadStream(filePath);
    const file = await blob(fileStream);
    formData.append("file", file, fileName);

    const uploadResponse = await fetch(url, {
      method: "POST",
      body: formData,
      headers: {},
    });

    if (!uploadResponse.ok) {
      throw new Error(
        `Upload failed (${uploadResponse.status} ${uploadResponse.statusText}): ${await uploadResponse.text()}`,
      );
    }
    return key;
  }
}
