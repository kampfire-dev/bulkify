import { ClientResponse } from "@shopify/graphql-client";
import { GraphqlClient } from "@shopify/shopify-api";
import { XMLParser } from "fast-xml-parser";
import fsPromises from "fs/promises";
import fs, { createReadStream } from "node:fs";
import stream from "node:stream";
import { blob } from "node:stream/consumers";
import ora from "ora";
import path from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { wait } from "./utils/index.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BulkifyOptions {
  client: GraphqlClient;
  resultsPath?: string;
  deleteFiles?: boolean;
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

export default class Bulkify {
  client: GraphqlClient;
  resultsPath: string;
  private deleteFiles: boolean;

  constructor(options: BulkifyOptions) {
    this.client = options.client;
    this.resultsPath =
      options.resultsPath || path.resolve(__dirname, "results");
    this.deleteFiles =
      options.deleteFiles === undefined ? true : options.deleteFiles;
  }

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

    const result = await this.client.request<{
      bulkOperationRunQuery: BullkOperationResponse;
    }>(BULK_QUERY);

    return result;
  }

  async createBulkMutation(
    mutation: string,
    stagedUploadPath: string
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

    const result = await this.client.request<{
      bulkOperationRunMutation: {
        bulkOperation: {
          id: string;
          status: string;
        };
        userErrors: {
          field: string;
          message: string;
        }[];
      };
    }>(BULK_MUTATION);

    return result;
  }

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

    const result = await this.client.request<{
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
    }>(BULK_QUERY_STATUS);

    return result;
  }

  async pollCurrentOperation(
    type: "QUERY" | "MUTATION" = "QUERY",
    pollingTime: number = 2000
  ) {
    const spinner = ora("Polling current operation").start();
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

      spinner.text = `Polling current operation: ${status}`;

      if (status === "COMPLETED") {
        isRunning = false;
      } else if (
        status === "FAILED" ||
        status === "EXPIRED" ||
        status === "CANCELED"
      ) {
        spinner.fail("Bulk operation failed");
        throw new Error(
          `Bulk operation failed with status: ${status} and error code: ${errorCode}`
        );
      }

      if (isRunning) {
        await wait(pollingTime);
      } else {
        jsonURL = url;
        bulkObjects = objectCount;
      }
    } while (isRunning);

    spinner.succeed("Bulk operation completed");
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
      `bulk-operation-${new Date().toISOString()}.json`
    );

    const writeStream = fs.createWriteStream(fileName);

    if (!res.body) {
      throw new Error("No body found in response");
    }

    stream.Readable.fromWeb(res.body).pipe(writeStream);

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
    console.log(`Bulk operation results written to: ${file}`);

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
    type: "QUERY" | "MUTATION" = "QUERY"
  ) {
    const { jsonURL, bulkObjects } = await this.pollCurrentOperation(type);

    console.log("Bulk objects found:", bulkObjects);
    console.log("JSON URL:", jsonURL);

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

    return this.getReadInterfaceFromCurrentOperation<T>();
  }

  private async bulkMutation(mutation: string, filePath: string) {
    const key = await this.uploadBulkJSONL(filePath);
    console.log("Bulk mutation key:", key);
    const { data } = await this.createBulkMutation(mutation, key);

    if (!data) {
      throw new Error("Bulk mutation not created");
    }

    const { bulkOperation, userErrors } = data.bulkOperationRunMutation;

    if (userErrors.length > 0) {
      console.log(userErrors[0]);
      throw new Error("User errors found");
    }
  }

  private async rawBulkMutation<T>(mutation: string, filePath: string) {
    await this.bulkMutation(mutation, filePath);
    return await this.getReadInterfaceFromCurrentOperation<T>("MUTATION");
  }

  async runLastBulkQuery<T>() {
    return this.getReadInterfaceFromCurrentOperation();
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

    const response = await this.client.request<{
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
    }>(STAGED_UPLOADS_CREATE);

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
      throw new Error("Upload failed");
    }
  }
}
