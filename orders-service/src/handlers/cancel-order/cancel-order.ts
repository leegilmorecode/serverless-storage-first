import * as AWS from "aws-sdk";

import { Client } from "pg";
import { Handler } from "aws-lambda";
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
  const client = new Client(options);
  await client.connect();
  return client;
}

export const cancelOrderHandler: Handler = async (
  event: any
): Promise<void> => {
  const { body } = event;

  try {
    const correlationId = uuid();
    const method = "cancel-order.handler";
    const prefix = `${correlationId} - ${method}`;

    console.log(`${prefix} - started`);

    const client = await connectToDb();
    console.log(`${prefix} - conected to db`);

    await client.query(
      `DELETE FROM online WHERE username = '${body.username}';`
    );
    console.log(`${prefix} - cancelled successfully for user ${body.username}`);

    client.end();
  } catch (error) {
    console.error(`Error: ${error}`);
    throw new Error(JSON.stringify(body));
  }
};
