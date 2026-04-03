import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export class NotesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ECR_REPO = '119287771917.dkr.ecr.eu-north-1.amazonaws.com/notes-application';
    const CDN_ORIGIN = 'https://d1q6rp644iikc2.cloudfront.net';

    // ─── 1. VPC ────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'NotesVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // ─── 2. ECS Cluster ────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'NotesCluster', {
      vpc,
      clusterName: 'notes-cluster',
      defaultCloudMapNamespace: {
        name: 'notes.local',  // internal DNS for service discovery
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
        vpc,
      },
    });

    // ─── 3. IAM Execution Role ─────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    // ─── 4. ECR Pull Permissions ───────────────────────────────
    const repo = ecr.Repository.fromRepositoryArn(
      this,
      'NotesRepo',
      `arn:aws:ecr:eu-north-1:119287771917:repository/notes-application`
    );
    repo.grantPull(executionRole);

    // Explicit ECR permissions for pulling images
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // ─── 5. Security Groups ────────────────────────────────────
    const postgresSG = new ec2.SecurityGroup(this, 'PostgresSG', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for Postgres service',
    });

    const apiSG = new ec2.SecurityGroup(this, 'ApiSG', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for API service',
    });

    // Allow API to talk to Postgres on port 5432
    postgresSG.addIngressRule(
      apiSG,
      ec2.Port.tcp(5432),
      'Allow API to connect to Postgres'
    );

    // Allow ALB to talk to API on port 8080
    apiSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow ALB to API'
    );

    // ─── 6. Postgres Task Definition ───────────────────────────
    const postgresTaskDef = new ecs.FargateTaskDefinition(this, 'PostgresTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      executionRole,
    });

    postgresTaskDef.addContainer('postgres', {
      image: ecs.ContainerImage.fromRegistry('postgres:16'),
      containerName: 'notes-postgres',
      environment: {
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'notesdb',
      },
      portMappings: [{ containerPort: 5432 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'postgres',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    postgresTaskDef.addContainer('pgadmin', {
      image: ecs.ContainerImage.fromRegistry('dpage/pgadmin4:8'),
      containerName: 'notes-pgadmin',
      environment: {
        PGADMIN_DEFAULT_EMAIL: 'admin@admin.com',
        PGADMIN_DEFAULT_PASSWORD: 'admin',
      },
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'pgadmin',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    // ─── 7. Postgres Service ───────────────────────────────────
    const postgresService = new ecs.FargateService(this, 'PostgresService', {
      cluster,
      taskDefinition: postgresTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [postgresSG],
      serviceName: 'notes-postgres-service',
      // Service discovery so API can reach postgres via DNS
      cloudMapOptions: {
        name: 'postgres',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // ─── 8. API Task Definition ────────────────────────────────
    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      executionRole,
    });

    apiTaskDef.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry(`${ECR_REPO}:latest`),
      containerName: 'notes-api',
      environment: {
        ASPNETCORE_ENVIRONMENT: 'Development'
    
      },
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });
    // ─── 9. ALB ────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'NotesALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'notes-alb',
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    // ─── 10. API Service ───────────────────────────────────────
    const apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 0,
      assignPublicIp: false,
      securityGroups: [apiSG],
      serviceName: 'notes-api-service',
    });

    // ─── 11. ALB Target Group ──────────────────────────────────
    listener.addTargets('NotesTarget', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        apiService.loadBalancerTarget({
          containerName: 'notes-api',
          containerPort: 8080,
        }),
      ],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: '200-499',
      },
    });

    // ─── 12. API GATEWAY ───────────────────────────────────────
   const api = new apigateway.RestApi(this, 'NotesApiGateway', {
  restApiName: 'notes-api-gateway',
  description: 'API Gateway for Notes Application',
  defaultCorsPreflightOptions: {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,  // ✅ allow all origins
    allowMethods: apigateway.Cors.ALL_METHODS,
    allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
    allowCredentials: false,  // ✅ must be false with ALL_ORIGINS
  },
  deployOptions: {
    stageName: 'dev',
    throttlingRateLimit: 33,
    throttlingBurstLimit: 500,
    loggingLevel: apigateway.MethodLoggingLevel.INFO,
    metricsEnabled: true,
    dataTraceEnabled: true,
  },
});
    // ─── ALB Integration ───────────────────────────────────────
    const albIntegration = new apigateway.HttpIntegration(
      `http://${alb.loadBalancerDnsName}/{proxy}`,
      {
        httpMethod: 'ANY',
        options: {
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
          },
          integrationResponses: [
            {
              statusCode: '200',
              responseParameters: {
                'method.response.header.Access-Control-Allow-Origin': `'${CDN_ORIGIN}'`,
                'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Origin,Accept'",
                'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS,PATCH'",
              },
            },
          ],
        },
      }
    );

    const proxyResource = api.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', albIntegration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
          },
        },
      ],
    });

    const scalarIntegration = new apigateway.HttpIntegration(
      `http://${alb.loadBalancerDnsName}/scalar`,
      {
        httpMethod: 'GET',
        options: {
          integrationResponses: [
            {
              statusCode: '200',
              responseParameters: {
                'method.response.header.Access-Control-Allow-Origin': `'${CDN_ORIGIN}'`,
              },
            },
          ],
        },
      }
    );

    const scalarResource = api.root.addResource('scalar');
    scalarResource.addMethod('GET', scalarIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    const scalarProxyIntegration = new apigateway.HttpIntegration(
      `http://${alb.loadBalancerDnsName}/scalar/{proxy}`,
      {
        httpMethod: 'GET',
        options: {
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
          },
          integrationResponses: [
            {
              statusCode: '200',
              responseParameters: {
                'method.response.header.Access-Control-Allow-Origin': `'${CDN_ORIGIN}'`,
              },
            },
          ],
        },
      }
    );

    const scalarProxyResource = scalarResource.addResource('{proxy+}');
    scalarProxyResource.addMethod('GET', scalarProxyIntegration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // ─── 13. S3 Bucket ─────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'NotesWebBucket', {
      bucketName: `notes-webapp-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: [CDN_ORIGIN],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['Origin', 'Content-Type', 'Accept', 'Authorization'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // ─── 14. CloudFront ────────────────────────────────────────
    const corsCachePolicy = new cloudfront.CachePolicy(this, 'CorsApiCachePolicy', {
      cachePolicyName: 'NotesCorsApiPolicy',
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'Origin',
        'Access-Control-Request-Headers',
        'Access-Control-Request-Method',
      ),
    });

    const corsOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'CorsOriginRequestPolicy',
      {
        originRequestPolicyName: 'NotesCorsOriginPolicy',
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          'Origin',
          'Access-Control-Request-Headers',
          'Access-Control-Request-Method',
        ),
      }
    );

    const distribution = new cloudfront.Distribution(this, 'NotesDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${api.restApiId}.execute-api.eu-north-1.amazonaws.com`,
            { originPath: '/dev' }
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: corsCachePolicy,
          originRequestPolicy: corsOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        '/scalar': {
          origin: new origins.HttpOrigin(
            `${api.restApiId}.execute-api.eu-north-1.amazonaws.com`,
            { originPath: '/dev' }
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: corsOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        '/scalar/*': {
          origin: new origins.HttpOrigin(
            `${api.restApiId}.execute-api.eu-north-1.amazonaws.com`,
            { originPath: '/dev' }
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: corsOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // ─── OUTPUTS ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ALBDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Load Balancer URL',
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'ApiGatewayScalarUrl', {
      value: `${api.url}scalar`,
      description: 'Scalar Docs via API Gateway',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL (Web App)',
    });

    new cdk.CfnOutput(this, 'CloudFrontScalarUrl', {
      value: `https://${distribution.distributionDomainName}/scalar`,
      description: 'Scalar Docs via CloudFront',
    });

    new cdk.CfnOutput(this, 'WebBucketName', {
      value: webBucket.bucketName,
      description: 'S3 Bucket for Web App',
    });
  }
}
