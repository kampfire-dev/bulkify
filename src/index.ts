import { ClientResponse, GraphQLClient } from "@shopify/graphql-client";
import { XMLParser } from "fast-xml-parser";
import fs, { createReadStream } from "fs";
import fsPromises from "fs/promises";
import stream from "node:stream";
import ora from "ora";
import path from "path";
import { Interface, createInterface } from "readline";
import { fileURLToPath } from "url";
import { wait } from "./utils/index.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BulkifyOptions {
  client: GraphQLClient;
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
  client: GraphQLClient;
  resultsPath: string;
  private deleteFiles: boolean;

  constructor(options: BulkifyOptions) {
    this.client = options.client;
    this.resultsPath =
      options.resultsPath || path.resolve(__dirname, "results");
    this.deleteFiles = options.deleteFiles || true;
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

    console.log(BULK_QUERY);

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

  async getBulkOperationStatus(type: "QUERY" | "MUTATION") {
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

  private async getReadInterface<T>() {
    const { jsonURL, bulkObjects } = await this.pollCurrentOperation();

    console.log("Bulk objects found:", bulkObjects);
    console.log("JSON URL:", jsonURL);

    if (bulkObjects === 0) {
      throw new Error("No bulk objects found");
    }

    if (!jsonURL) {
      throw new Error("No JSON URL found");
    }

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

  private async rawBulkQuery(query: string): Promise<Interface> {
    const { data } = await this.createBulkQuery(query);
    if (!data) {
      throw new Error("Bulk query not created");
    }

    const { bulkOperation, userErrors } = data.bulkOperationRunQuery;

    if (userErrors.length > 0) {
      console.log(userErrors[0]);
      throw new Error("User errors found");
    }

    return await this.getReadInterface();
  }

  async *runLastBulkQuery<T>() {
    const rl = await this.getReadInterface<T>();
    for await (const line of rl) {
      const obj = JSON.parse(line) as T;
      yield obj;
    }
  }

  async *runBulkQuery<T>(query: string) {
    const rl = await this.rawBulkQuery(query);
    for await (const line of rl) {
      const obj = JSON.parse(line) as T;
      yield obj;
    }
  }

  async uploadBulkJSONL(filePath: string) {
    const STAGED_UPLOADS_CREATE = `mutation {
      stagedUploadsCreate(input: {
        resource: BULK_MUTATION_VARIABLES,
        filename: "${path.basename(filePath)}",
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
    formData.append("file", fs.createReadStream(filePath));

    const uploadResponse = await fetch(url, {
      method: "POST",
      body: formData,
    });

    const data = await uploadResponse.text();
    const parser = new XMLParser();
    const xml = parser.parse(data);
    return xml.PostResponse.Key[0];
  }
}
