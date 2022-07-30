import * as AWS from "aws-sdk";

import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { Client, QueryResult } from "pg";

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

export const listOrdersHandler: APIGatewayProxyHandler =
  async (): Promise<APIGatewayProxyResult> => {
    try {
      const correlationId = uuid();
      const method = "list-orders.handler";
      const prefix = `${correlationId} - ${method}`;

      console.log(`${prefix} - started`);

      const client: Client = await connectToDb();

      const query: QueryResult<any> = await client.query(
        "SELECT * FROM online;"
      );
      const result = query.rows;
      console.log(`result: ${JSON.stringify(result)}`);

      await client.end();
      return {
        statusCode: 200,
        body: JSON.stringify(result),
      };
    } catch (error) {
      console.error(error);
      return {
        statusCode: 500,
        body: "An error occurred",
      };
    }
  };
