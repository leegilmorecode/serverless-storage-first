import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import * as rds from "aws-cdk-lib/aws-rds";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";

import {
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { EventBus, IEventBus } from "aws-cdk-lib/aws-events";

import { Construct } from "constructs";

export class OrdersServiceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // import resources from the infra stack
    const importedSecurityGroupId = cdk.Fn.importValue(
      "OrdersDbProxySecurityGroupId"
    );
    const importedOrdersDbProxyArn = cdk.Fn.importValue("OrdersDbProxyArn");
    const importedOrdersDbProxyName = cdk.Fn.importValue("OrdersDbProxyName");
    const importedOrdersDbProxyEndpoint = cdk.Fn.importValue(
      "OrdersDbProxyEndpoint"
    );

    const importedSecurityGroup: ec2.ISecurityGroup =
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "imported-security-group",
        importedSecurityGroupId
      );

    const importedVpc: ec2.IVpc = ec2.Vpc.fromLookup(this, "ImportedVPC", {
      vpcName: "infra-vpc",
    });

    const eventBus: IEventBus = EventBus.fromEventBusName(
      this,
      "OnlineOrders",
      "OnlineOrdersEventBus"
    );

    // import rds proxy from our infra stack
    const importedDbProxy: rds.IDatabaseProxy =
      rds.DatabaseProxy.fromDatabaseProxyAttributes(this, "CustomerRdsProxy", {
        dbProxyArn: importedOrdersDbProxyArn,
        dbProxyName: importedOrdersDbProxyName,
        endpoint: importedOrdersDbProxyEndpoint,
        securityGroups: [importedSecurityGroup],
      });

    // shared lambda env vars
    const environment = {
      DB_PORT: "5432",
      DB_NAME: "orders",
      DB_USER: "postgres",
      DB_HOST: importedDbProxy.endpoint,
      REGION: cdk.Aws.REGION,
    };

    // dlq for lambda destinations i.e. on error in the lambda
    const createOrderLambdaDlq: sqs.Queue = new sqs.Queue(
      this,
      "CreateOrderLambdaDlq",
      {
        removalPolicy: RemovalPolicy.DESTROY,
        queueName: "create-order-lambda-dlq",
      }
    );

    // create our various lambda handlers
    const createOrderHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "CreateOrderHandler", {
        functionName: "create-order-handler",
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: path.join(
          __dirname,
          "/../src/handlers/create-order/create-order.ts"
        ),
        memorySize: 1024,
        handler: "createOrderHandler",
        onFailure: new destinations.SqsDestination(createOrderLambdaDlq),
        bundling: {
          minify: true,
          externalModules: ["aws-sdk", "pg-native"],
        },
        vpc: importedVpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [importedSecurityGroup],
        environment,
      });

    const cancelOrderHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "CancelOrderHandler", {
        functionName: "cancel-order-handler",
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: path.join(
          __dirname,
          "/../src/handlers/cancel-order/cancel-order.ts"
        ),
        memorySize: 1024,
        handler: "cancelOrderHandler",
        bundling: {
          minify: true,
          externalModules: ["aws-sdk", "pg-native"],
        },
        vpc: importedVpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [importedSecurityGroup],
        environment,
      });

    const listOrdersHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "ListOrdersHandler", {
        functionName: "list-orders-handler",
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: path.join(
          __dirname,
          "/../src/handlers/list-orders/list-orders.ts"
        ),
        memorySize: 1024,
        handler: "listOrdersHandler",
        bundling: {
          minify: true,
          externalModules: ["aws-sdk", "pg-native"],
        },
        vpc: importedVpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [importedSecurityGroup],
        environment,
      });

    const createTableHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "CreateOnlineTableHandler", {
        functionName: "create-online-table-handler",
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: path.join(
          __dirname,
          "/../src/handlers/create-table/create-table.ts"
        ),
        memorySize: 1024,
        handler: "createTableHandler",
        bundling: {
          minify: true,
          externalModules: ["aws-sdk", "pg-native"],
        },
        vpc: importedVpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [importedSecurityGroup],
        environment,
      });

    // allow each lambda to connect to rds proxy
    importedDbProxy.grantConnect(createOrderHandler, "postgres");
    importedDbProxy.grantConnect(cancelOrderHandler, "postgres");
    importedDbProxy.grantConnect(listOrdersHandler, "postgres");
    importedDbProxy.grantConnect(createTableHandler, "postgres");

    // this custom resource will create our postgres table on deploy if it doesn't exist
    const provider: cr.Provider = new cr.Provider(
      this,
      "CreateOnlineOrdersTableCustomResource",
      {
        onEventHandler: createTableHandler, // this lambda will be called on cfn deploy
        logRetention: logs.RetentionDays.ONE_DAY,
        providerFunctionName: "create-online-table-custom-resource",
      }
    );

    new CustomResource(this, "CustomResource", {
      serviceToken: provider.serviceToken,
      properties: {
        ...environment,
      },
    });

    // create the online orders api
    const onlineOrdersApi: apigw.RestApi = new apigw.RestApi(
      this,
      "OnlineOrdersApi",
      {
        description: "Online Orders API",
        restApiName: "online-orders-api",
        deploy: true,
        deployOptions: {
          stageName: "prod",
          dataTraceEnabled: true,
          loggingLevel: apigw.MethodLoggingLevel.INFO,
          tracingEnabled: true,
          metricsEnabled: true,
        },
      }
    );

    // create the state machine defintion for cancelling an order
    const cancelOrderStateMachineDefinition: sfn.TaskStateBase =
      new tasks.LambdaInvoke(this, "CancelOrder", {
        lambdaFunction: cancelOrderHandler,
        resultPath: "$",
        timeout: Duration.seconds(30),
        comment: "Cancel order task",
        retryOnServiceExceptions: true,
      }).addCatch(
        new tasks.SqsSendMessage(this, "SendSQSFailure", {
          queue: new sqs.Queue(this, "CancelOrderLambdaFailureDLQ", {
            queueName: "cancel-order-lambda-failure-dlq",
          }),
          messageBody: sfn.TaskInput.fromJsonPathAt(
            "States.StringToJson($.Cause)"
          ),
        })
      );

    // create the state machine for cancelling orders
    const cancelOrderStateMachine: sfn.StateMachine = new sfn.StateMachine(
      this,
      "CancelOrderStateMachine",
      {
        definition: cancelOrderStateMachineDefinition,
        logs: {
          level: sfn.LogLevel.ALL,
          destination: new logs.LogGroup(
            this,
            "cancelOrderStateMachineLogGroup",
            {
              retention: logs.RetentionDays.ONE_DAY,
            }
          ),
          includeExecutionData: true,
        },
        tracingEnabled: true,
        stateMachineName: "CancelOrderStateMachine",
        stateMachineType: sfn.StateMachineType.EXPRESS,
        timeout: Duration.seconds(30),
      }
    );

    const orders: apigw.Resource = onlineOrdersApi.root.addResource("orders");

    const apigwRole: iam.Role = new iam.Role(this, "OnlineOrdersRole", {
      assumedBy: new iam.ServicePrincipal("apigateway"),
      inlinePolicies: {
        putEvents: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["events:PutEvents"],
              resources: [eventBus.eventBusArn],
            }),
            new iam.PolicyStatement({
              actions: ["states:StartSyncExecution"],
              effect: iam.Effect.ALLOW,
              resources: [cancelOrderStateMachine.stateMachineArn],
            }),
          ],
        }),
      },
    });

    // lambda integration to list the created orders
    orders.addMethod(
      "GET",
      new apigw.LambdaIntegration(listOrdersHandler, {
        proxy: true,
        allowTestInvoke: true,
      })
    );

    // event bridge options for the api gateway integration
    const eventBridgeOptions: apigw.IntegrationOptions = {
      credentialsRole: apigwRole,
      requestParameters: {
        "integration.request.header.X-Amz-Target": "'AWSEvents.PutEvents'",
        "integration.request.header.Content-Type":
          "'application/x-amz-json-1.1'",
      },
      requestTemplates: {
        "application/json": `{"Entries": [{"Source": "com.lee.pizza", "Detail":"$util.escapeJavaScript($input.json('$'))", "DetailType": "CreateOrder", "EventBusName": "${eventBus.eventBusName}"}]}`,
      },
      integrationResponses: [
        {
          statusCode: "200",
          responseTemplates: {
            "application/json": "Created",
          },
        },
      ],
    };

    // step function options for the api gateway integration
    const stepFunctionOptions: apigw.IntegrationOptions = {
      credentialsRole: apigwRole,
      integrationResponses: [
        {
          statusCode: "200",
          responseTemplates: {
            "application/json": "Cancelled",
          },
        },
      ],
      passthroughBehavior: apigw.PassthroughBehavior.NEVER,
      requestTemplates: {
        "application/json": `{
              "input": "{\\"actionType\\": \\"cancel\\", \\"body\\": $util.escapeJavaScript($input.json('$'))}",
              "stateMachineArn": "${cancelOrderStateMachine.stateMachineArn}"
            }`,
      },
    };

    // the create order endpoint persists a message directly on eventbridge
    orders.addMethod(
      "POST",
      new apigw.Integration({
        type: apigw.IntegrationType.AWS,
        uri: `arn:aws:apigateway:${cdk.Aws.REGION}:events:path//`,
        integrationHttpMethod: "POST",
        options: eventBridgeOptions,
      }),
      { methodResponses: [{ statusCode: "200" }] }
    );

    // the cancel order endpoint persists a message directly with state machine
    orders.addMethod(
      "PUT",
      new apigw.Integration({
        type: apigw.IntegrationType.AWS,
        uri: `arn:aws:apigateway:${cdk.Aws.REGION}:states:action/StartSyncExecution`,
        integrationHttpMethod: "POST",
        options: stepFunctionOptions,
      }),
      { methodResponses: [{ statusCode: "200" }] }
    );

    const createOrdersDlq: sqs.Queue = new sqs.Queue(this, "CreateOrdersDlq", {
      removalPolicy: RemovalPolicy.DESTROY,
      queueName: "create-orders-dlq",
    });

    new events.Rule(this, "CreateOrderLambdaProcessorRule", {
      eventBus,
      eventPattern: { source: ["com.lee.pizza"] },
      targets: [
        new targets.LambdaFunction(createOrderHandler, {
          deadLetterQueue: createOrdersDlq,
        }),
      ],
    });
  }
}
