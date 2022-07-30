import * as AWS from "aws-sdk";

import { Client, QueryResult } from "pg";
import { EventBridgeEvent, Handler } from "aws-lambda";

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

async function connectToDb(): Promise<Client> {
  const token = signer.getAuthToken({
    username: process.env.DB_USER,
  });

  options.password = token;

  console.log(`attempting to connect to db`);
  const client: Client = new Client(options);
  await client.connect();
  return client;
}

export const createOrderHandler: Handler = async (
  event: EventBridgeEvent<any, any>
): Promise<void> => {
  try {
    const correlationId = uuid();
    const method = "create-order.handler";
    const prefix = `${correlationId} - ${method}`;

    console.log(`${prefix} - started`);

    const { detail } = event;

    const client: Client = await connectToDb();
    const query: QueryResult<any> = await client.query(
      `INSERT INTO online(username) VALUES ('${detail.username}');`
    );
    const result = query.rows;
    console.log(`${prefix} - result: ${JSON.stringify(result)}`);

    client.end();
  } catch (error) {
    console.error(error);
    throw error;
  }
};
