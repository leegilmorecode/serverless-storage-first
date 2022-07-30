import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";

import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";

import { CloudWatchLogGroup } from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import { LogGroup } from "aws-cdk-lib/aws-logs";

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const eventBus: EventBus = new EventBus(this, "OnlineOrdersEventBus", {
      eventBusName: "OnlineOrdersEventBus",
    });

    const eventLoggerRule: Rule = new Rule(
      this,
      "OnlineOrdersEventBusEventLoggerRule",
      {
        description: "Log all events from OnlineOrdersEventBus",
        eventPattern: {
          region: [cdk.Stack.of(this).region],
        },
        eventBus: eventBus,
      }
    );

    const logGroup = new LogGroup(this, "OnlineOrdersEventBusEventLogGroup", {
      logGroupName: "/aws/events/OnlineOrdersEventBus",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    eventLoggerRule.addTarget(new CloudWatchLogGroup(logGroup));

    // https://github.com/aws/aws-cdk/issues/20197
    enum ServerlessInstanceType {
      SERVERLESS = "serverless",
    }

    type CustomInstanceType = ServerlessInstanceType | ec2.InstanceType;

    const CustomInstanceType = {
      ...ServerlessInstanceType,
      ...ec2.InstanceType,
    };

    const dbClusterInstanceCount: number = 1;

    const vpc: ec2.Vpc = new ec2.Vpc(this, "InfraVPC", {
      maxAzs: 2,
      natGateways: 1,
      vpcName: "infra-vpc",
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "private-subnet",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: "public-subnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const dbCluster: rds.DatabaseCluster = new rds.DatabaseCluster(
      this,
      "ServerlessAuroraDbCluster",
      {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_13_7,
        }),
        clusterIdentifier: "ServerlessAuroraDbCluster",
        removalPolicy: RemovalPolicy.DESTROY,
        defaultDatabaseName: "orders",
        instances: dbClusterInstanceCount,
        instanceProps: {
          vpc: vpc,
          deleteAutomatedBackups: true,
          instanceType:
            CustomInstanceType.SERVERLESS as unknown as ec2.InstanceType,
          autoMinorVersionUpgrade: false,
          publiclyAccessible: false,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        },
        backup: {
          retention: Duration.days(1),
          preferredWindow: "08:00-09:00",
        },
        port: 5432,
        cloudwatchLogsExports: ["postgresql"],
        cloudwatchLogsRetention: logs.RetentionDays.ONE_DAY,
        storageEncrypted: true,
      }
    );

    const serverlessV2ScalingConfiguration = {
      MinCapacity: 0.5,
      MaxCapacity: 1,
    };

    const dbConnectionGroup: ec2.SecurityGroup = new ec2.SecurityGroup(
      this,
      "RdsProxyDBConnection",
      {
        vpc,
        securityGroupName: "rds-proxy-sg",
      }
    );

    dbConnectionGroup.addIngressRule(
      dbConnectionGroup,
      ec2.Port.tcp(5432),
      "allow db connection"
    );

    const proxy: rds.DatabaseProxy = new rds.DatabaseProxy(
      this,
      "CustomerRdsProxy",
      {
        proxyTarget: rds.ProxyTarget.fromCluster(dbCluster),
        secrets: [dbCluster.secret!],
        securityGroups: [dbConnectionGroup],
        dbProxyName: "orders-serverless-v2-rds-proxy",
        debugLogging: true,
        iamAuth: true,
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      }
    );

    const dbScalingConfigure: cr.AwsCustomResource = new cr.AwsCustomResource(
      this,
      "DbScalingConfigure",
      {
        onCreate: {
          service: "RDS",
          action: "modifyDBCluster",
          parameters: {
            DBClusterIdentifier: dbCluster.clusterIdentifier,
            ServerlessV2ScalingConfiguration: serverlessV2ScalingConfiguration,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            dbCluster.clusterIdentifier
          ),
        },
        onUpdate: {
          service: "RDS",
          action: "modifyDBCluster",
          parameters: {
            DBClusterIdentifier: dbCluster.clusterIdentifier,
            ServerlessV2ScalingConfiguration: serverlessV2ScalingConfiguration,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            dbCluster.clusterIdentifier
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    const cfnDbCluster: rds.CfnDBCluster = dbCluster.node
      .defaultChild as rds.CfnDBCluster;
    const dbScalingConfigureTarget = dbScalingConfigure.node.findChild(
      "Resource"
    ).node.defaultChild as CfnResource;

    cfnDbCluster.addPropertyOverride("EngineMode", "provisioned");
    dbScalingConfigure.node.addDependency(cfnDbCluster);

    for (let i = 1; i <= dbClusterInstanceCount; i++) {
      (
        dbCluster.node.findChild(`Instance${i}`) as rds.CfnDBInstance
      ).addDependsOn(dbScalingConfigureTarget);
    }

    new CfnOutput(this, "OrdersDbHostname", {
      value: dbCluster.clusterEndpoint.hostname,
      exportName: "OrdersDbHostname",
    });

    new CfnOutput(this, "OrdersDbProxyArn", {
      value: proxy.dbProxyArn,
      exportName: "OrdersDbProxyArn",
    });

    new CfnOutput(this, "OrdersDbProxyName", {
      value: proxy.dbProxyName,
      exportName: "OrdersDbProxyName",
    });

    new CfnOutput(this, "OrdersDbProxyEndpoint", {
      value: proxy.endpoint,
      exportName: "OrdersDbProxyEndpoint",
    });

    new CfnOutput(this, "OrdersDbProxySecurityGroupId", {
      value: dbConnectionGroup.securityGroupId,
      exportName: "OrdersDbProxySecurityGroupId",
    });
  }
}
