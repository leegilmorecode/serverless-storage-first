#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "aws-cdk-lib";

import { OrdersServiceStack } from "../lib/orders-service-stack";

const app = new cdk.App();
new OrdersServiceStack(app, "OrdersServiceStack", {
  env: {
    account: "account-id", // your account id here
    region: "eu-west-1",
  },
});
