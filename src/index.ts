import { XMLParser } from "fast-xml-parser";
import fsPromises from "fs/promises";
import fs, { createReadStream } from "node:fs";
import stream from "node:stream";
import { blob } from "node:stream/consumers";
import ora, { type Ora } from "ora";
import path from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { wait } from "./utils/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  /** Show a terminal spinner while polling. On by default */
  spinner?: boolean;
}

export type BulkOperationStatus =
  | "CANCELED"
  | "CANCELING"
  | "COMPLETED"
  | "CREATED"
  | "EXPIRED"
  | "FAILED"
  | "RUNNING";

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

  /** True when another bulk operation is still running on the store */
  get inProgress() {
    return this.userErrors.some(
      (error) => error.code === "OPERATION_IN_PROGRESS",
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

type BullkOperationResponse = {
  bulkOperation: {
    id: string;
    status: string;
  };
  userErrors: {
    field: string;
    message: string;
  }[];
};

type StagedUploadsCreateResponse = {
  stagedUploadsCreate: {
    userErrors: {
      field: string;
      message: string;
    }[];
    stagedTargets: {
      url: string;
      resourceUrl: string;
      parameters: {
        name: string;
        value: string;
      }[];
    }[];
  };
};

export const RUN_BULK_QUERY = `
  mutation BulkifyRunQuery($query: String!, $groupObjects: Boolean) {
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

export const GET_BULK_OPERATION = `
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

const FINISHED: BulkOperationStatus[] = [
  "CANCELED",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
];

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
      options.resultsPath || path.resolve(__dirname, "results");
    this.deleteFiles =
      options.deleteFiles === undefined ? true : options.deleteFiles;
    this.debug = options.debug;
    this.spinner = options.spinner ?? true;
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
  private async data<T>(query: string, variables?: Record<string, unknown>) {
    const { data, errors } = await this.run<T>(query, variables);
    if (errors && (!Array.isArray(errors) || errors.length > 0)) {
      throw new Error(`GraphQL error: ${JSON.stringify(errors)}`);
    }
    if (!data) {
      throw new Error("No data returned");
    }
    return data;
  }

  // Operations by id. These don't depend on currentBulkOperation, which is
  // deprecated, and work while several operations run on one store.

  /** Starts a bulk query and returns the operation. Doesn't wait for it */
  async startBulkQuery(
    query: string,
    options: { groupObjects?: boolean } = {},
  ): Promise<{ id: string; status: BulkOperationStatus }> {
    if (this.debug) console.log(query);
    const data = await this.data<{
      bulkOperationRunQuery: {
        bulkOperation: { id: string; status: BulkOperationStatus } | null;
        userErrors: BulkUserError[];
      };
    }>(RUN_BULK_QUERY, {
      query,
      groupObjects: options.groupObjects ?? null,
    });
    const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
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
    const data = await this.data<{ bulkOperation: BulkOperation | null }>(
      GET_BULK_OPERATION,
      { id },
    );
    return data.bulkOperation;
  }

  /**
   * Polls until the operation finishes. Resolves with it when completed and
   * throws BulkifyOperationError when it failed, was cancelled or expired.
   */
  async waitForBulkOperation(
    id: string,
    { pollingTime = 2000, signal }: { pollingTime?: number; signal?: AbortSignal } = {},
  ): Promise<BulkOperation> {
    for (;;) {
      signal?.throwIfAborted();
      const operation = await this.getBulkOperation(id);
      if (!operation) {
        throw new Error(`Bulk operation ${id} not found`);
      }
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

  async createBulkQuery(query: string): Promise<
    ClientResponse<{
      bulkOperationRunQuery: BullkOperationResponse;
    }>
  > {
    const BULK_QUERY = `mutation {
      bulkOperationRunQuery(
        query:"""
        ${query}
        """
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`;

    if (this.debug) {
      console.log(BULK_QUERY);
    }

    return this.run<{ bulkOperationRunQuery: BullkOperationResponse }>(
      BULK_QUERY,
    );
  }

  async createBulkMutation(
    mutation: string,
    stagedUploadPath: string,
  ): Promise<
    ClientResponse<{
      bulkOperationRunMutation: BullkOperationResponse;
    }>
  > {
    const BULK_MUTATION = `mutation {
      bulkOperationRunMutation(
        mutation: "${mutation}",
        stagedUploadPath: "${stagedUploadPath}"
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`;

    if (this.debug) {
      console.log(BULK_MUTATION);
    }

    return this.run<{ bulkOperationRunMutation: BullkOperationResponse }>(
      BULK_MUTATION,
    );
  }

  /**
   * @deprecated `currentBulkOperation` is deprecated by Shopify. Use
   * `getBulkOperation(id)` instead.
   */
  async getBulkOperationStatus(type: "QUERY" | "MUTATION"): Promise<
    ClientResponse<{
      currentBulkOperation: {
        id: string;
        status: string;
        errorCode: string;
        createdAt: string;
        completedAt: string;
        objectCount: number;
        fileSize: number;
        url: string;
        partialDataUrl: string;
      };
    }>
  > {
    const BULK_QUERY_STATUS = `{
      currentBulkOperation(type: ${type}) {
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
    }`;

    return this.run(BULK_QUERY_STATUS);
  }

  async cancelBulkOperation(id: string) {
    const CANCEL_BULK_OPERATION = `
      mutation bulkOperationCancel($id: ID!) {
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

    return this.run<{ bulkOperationCancel: BullkOperationResponse }>(
      CANCEL_BULK_OPERATION,
      { id },
    );
  }

  async cancelCurrentBulkOperation(type: "QUERY" | "MUTATION") {
    const result = await this.getBulkOperationStatus(type);

    if (!result.data?.currentBulkOperation) {
      throw new Error("No bulk operation found");
    }

    const { id } = result.data.currentBulkOperation;

    return this.cancelBulkOperation(id);
  }

  private startSpinner(text: string): Ora | undefined {
    return this.spinner ? ora(text).start() : undefined;
  }

  async pollCurrentOperation(
    type: "QUERY" | "MUTATION" = "QUERY",
    pollingTime: number = 2000,
  ) {
    const spinner = this.startSpinner("Polling current operation");
    let isRunning = true;
    let jsonURL = "";
    let bulkObjects = 0;
    do {
      let result = await this.getBulkOperationStatus(type);

      if (!result.data?.currentBulkOperation) {
        throw new Error("No bulk operation found");
      }

      const { status, errorCode, objectCount, url } =
        result.data.currentBulkOperation;

      if (this.debug) {
        console.log(result.data.currentBulkOperation);
      }

      if (spinner) spinner.text = `Polling current operation: ${status}`;

      if (status === "COMPLETED") {
        isRunning = false;
      } else if (
        status === "FAILED" ||
        status === "EXPIRED" ||
        status === "CANCELED"
      ) {
        spinner?.fail("Bulk operation failed");
        throw new Error(
          `Bulk operation failed with status: ${status} and error code: ${errorCode}`,
        );
      }

      if (isRunning) {
        await wait(pollingTime);
      } else {
        jsonURL = url;
        bulkObjects = objectCount;
      }
    } while (isRunning);

    spinner?.succeed("Bulk operation completed");
    return { jsonURL, bulkObjects };
  }

  private async checkPath() {
    try {
      await fsPromises.access(this.resultsPath);
    } catch (err) {
      await fsPromises.mkdir(this.resultsPath, { recursive: true });
    }
  }

  private async writeResultsToFile(url: string) {
    await this.checkPath();

    const res = await fetch(url);

    const fileName = path.join(
      this.resultsPath,
      `bulk-operation-${new Date().toISOString()}.json`,
    );

    const writeStream = fs.createWriteStream(fileName);

    if (!res.body) {
      throw new Error("No body found in response");
    }

    stream.Readable.fromWeb(res.body as any).pipe(writeStream);

    return new Promise<string>((resolve, reject) => {
      writeStream.on("finish", () => {
        resolve(fileName);
      });

      writeStream.on("error", (err) => {
        reject(err);
      });
    });
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

  private async getReadInterfaceFromCurrentOperation<T>(
    type: "QUERY" | "MUTATION" = "QUERY",
  ) {
    const { jsonURL, bulkObjects } = await this.pollCurrentOperation(type);

    if (this.debug) {
      console.log("Bulk objects found:", bulkObjects);
      console.log("JSON URL:", jsonURL);
    }

    if (bulkObjects === 0) {
      throw new Error("No bulk objects found");
    }

    if (!jsonURL) {
      throw new Error("No JSON URL found");
    }

    return this.processURL<T>(jsonURL);
  }

  private async rawBulkQuery<T>(query: string) {
    const { data } = await this.createBulkQuery(query);
    if (!data) {
      throw new Error("Bulk query not created");
    }

    const { bulkOperation, userErrors } = data.bulkOperationRunQuery;

    if (userErrors.length > 0) {
      console.log(userErrors[0]);
      throw new Error("User errors found");
    }

    const generator = await this.getReadInterfaceFromCurrentOperation<T>();
    return { generator, bulkOperation };
  }

  private async bulkMutation(mutation: string, filePath: string) {
    const key = await this.uploadBulkJSONL(filePath);
    if (this.debug) console.log("Bulk mutation key:", key);
    const { data } = await this.createBulkMutation(mutation, key);

    if (!data) {
      throw new Error("Bulk mutation not created");
    }

    const { bulkOperation, userErrors } = data.bulkOperationRunMutation;

    if (userErrors.length > 0) {
      console.log(userErrors[0]);
      throw new Error("User errors found");
    }

    return bulkOperation;
  }

  private async rawBulkMutation<T>(mutation: string, filePath: string) {
    const bulkOperation = await this.bulkMutation(mutation, filePath);
    const generator =
      await this.getReadInterfaceFromCurrentOperation<T>("MUTATION");
    return { generator, bulkOperation };
  }

  async runLastBulkQuery<T>() {
    return this.getReadInterfaceFromCurrentOperation<T>();
  }

  runBulkQuery<T>(query: string) {
    return this.rawBulkQuery<T>(query);
  }

  runBulkMutation<T>(mutation: string, filePath: string) {
    return this.rawBulkMutation<T>(mutation, filePath);
  }

  async uploadBulkJSONL(filePath: string) {
    const fileName = path.basename(filePath);
    const STAGED_UPLOADS_CREATE = `mutation {
      stagedUploadsCreate(input: {
        resource: BULK_MUTATION_VARIABLES,
        filename: "${fileName}",
        mimeType: "text/jsonl",
        httpMethod: POST
      }) {
        userErrors {
          field,
          message
        },
        stagedTargets {
          url,
          resourceUrl,
          parameters {
            name,
            value
          }
        }
      }
    }`;

    const response =
      await this.run<StagedUploadsCreateResponse>(STAGED_UPLOADS_CREATE);

    if (!response.data) {
      throw new Error("No data found in response");
    }

    const {
      stagedUploadsCreate: { userErrors, stagedTargets },
    } = response.data;

    if (userErrors.length > 0) {
      console.log(userErrors[0]);
      throw new Error("User errors found");
    }

    const target = stagedTargets[0];

    if (!target) {
      throw new Error("No target found");
    }
    const { url, parameters } = target;

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

    if (uploadResponse.ok) {
      const data = await uploadResponse.text();
      const parser = new XMLParser();
      const xml = parser.parse(data);
      return xml.PostResponse.Key;
    } else {
      console.log(uploadResponse.status);
      console.log(uploadResponse.statusText);
      console.log(await uploadResponse.text());
      throw new Error("Upload failed");
    }
  }
}
