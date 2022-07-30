import * as AWS from "aws-sdk";

import {
  CdkCustomResourceEvent,
  CdkCustomResourceHandler,
  CdkCustomResourceResponse,
} from "aws-lambda";

import { Client } from "pg";
import { v4 as uuid } from "uuid";

const options = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  password: "",
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 1000,
};

const signer = new AWS.RDS.Signer({
  region: process.env.REGION,
  hostname: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
});

const physicalResourceId = "OnlineDatabaseTable";
let response: CdkCustomResourceResponse;

async function createTable(): Promise<void> {
  const token = signer.getAuthToken({
    username: process.env.DB_USER,
  });

  options.password = token;

  const client: Client = new Client(options);
  await client.connect();
  await client.query(
    "CREATE TABLE IF NOT EXISTS online (username varchar(45) NOT NULL, PRIMARY KEY (username));"
  );
  console.log(`Table created successfully`);
}

export const createTableHandler: CdkCustomResourceHandler = async (
  event: CdkCustomResourceEvent
): Promise<CdkCustomResourceResponse> => {
  try {
    const correlationId = uuid();
    const method = "create-table.handler";
    const prefix = `${correlationId} - ${method}`;

    console.log(`${prefix} - started`);

    switch (event.RequestType) {
      case "Create":
        await createTable();
        response = {
          Status: "SUCCESS",
          Reason: "",
          LogicalResourceId: event.LogicalResourceId,
          PhysicalResourceId: physicalResourceId,
          RequestId: event.RequestId,
          StackId: event.StackId,
        };
        break;
      case "Update":
        await createTable();
        response = {
          Status: "SUCCESS",
          Reason: "",
          LogicalResourceId: event.LogicalResourceId,
          PhysicalResourceId: physicalResourceId,
          RequestId: event.RequestId,
          StackId: event.StackId,
        };
        break;
      case "Delete":
        // we do nothing as the table will be removed
        response = {
          Status: "SUCCESS",
          Reason: "",
          LogicalResourceId: event.LogicalResourceId,
          PhysicalResourceId: physicalResourceId,
          RequestId: event.RequestId,
          StackId: event.StackId,
        };
        break;
      default:
        throw new Error(`${prefix} - event request type not found`);
    }

    console.log(`${prefix} - response: ${JSON.stringify(response)}`);

    return response;
  } catch (error) {
    console.error(error);
    return {
      Status: "FAILED",
      Reason: JSON.stringify(error),
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: physicalResourceId,
      RequestId: event.RequestId,
      StackId: event.StackId,
    };
  }
};
