import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as lambda from '@aws-cdk/aws-lambda';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as ecs from '@aws-cdk/aws-ecs';
import * as core from "@aws-cdk/core";
import * as logs from '@aws-cdk/aws-logs';
import * as iam from '@aws-cdk/aws-iam';
import * as path from 'path';
import * as codebuild from '@aws-cdk/aws-codebuild';

interface ConsumerStackProps extends cdk.StackProps {
  producerAccount: string
}


export class ConsumerStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ConsumerStackProps) {
    super(scope, id, props);

    const producerAccount = props.producerAccount

    // allow producer to put events into our eventbus
    new events.CfnEventBusPolicy(this, 'EventBusPolicy', {
      statementId: 'AllowCrossAccount',
      action: 'events:PutEvents',
      principal: producerAccount
    });

    const onLibraryReleaseRule = new events.Rule(this, 'LibraryReleaseRule', {
      eventPattern: {
        source: [ 'aws.codeartifact' ],
        detailType: [ 'CodeArtifact Package Version State Change' ],
        detail: {
          domainOwner: [ producerAccount ],
          packageVersionState: ['Published'],
          packageFormat: ['maven']
        }
      }
    });

    const codeCommitRepo = new codecommit.Repository(this, 'Repository' ,{
      repositoryName: 'DownstreamArtifact',
      description: 'Holds code with dependency to shared library'
    });

    new core.CfnOutput(this, 'CodeCommitCloneUrl', {
      exportName: 'CodeCommitCloneUrl',
      value: `export CODECOMMIT_URL=${codeCommitRepo.repositoryCloneUrlHttp}`
    });

    const cluster = new ecs.Cluster(this, 'ECSCluster', {containerInsights: true});
    const prCreationTask = new ecs.FargateTaskDefinition(this, `PullRequestCreatorTask`, {
      memoryLimitMiB: 512
    });

    codeCommitRepo.grantPullPush(prCreationTask.taskRole);
    codeCommitRepo.grant(prCreationTask.taskRole, 'codecommit:CreatePullRequest');

    const container = prCreationTask.addContainer(`PullRequestCreatorContainer`, {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', '..', 'library_consumer')),
      logging: new ecs.AwsLogDriver({
        streamPrefix: `PullRequestCreatorContainer`,
        logGroup: new logs.LogGroup(this, `PullRequestCreatorContainer`, {
          logGroupName: `/PullRequestCreatorContainer/${id}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: core.RemovalPolicy.DESTROY
        }),
      })
    });

    const runTaskLambda = new lambda.Function(this, 'RunECSTaskFunction', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../library_consumer/lambda-handler')),
      environment: {
        'TASK_DEFINITION_ARN' : prCreationTask.taskDefinitionArn,
        'CLUSTER_ARN' : cluster.clusterArn,
        'TASK_SUBNETS' : cluster.vpc.privateSubnets.map(subnet => subnet.subnetId).join(),
        'REPO_URL' : codeCommitRepo.repositoryCloneUrlHttp,
        'REPO_NAME' : codeCommitRepo.repositoryName,
        'REPO_REGION': this.region,
        'CONTAINER_NAME': container.containerName
      }
    });

    // setup required IAM roles to run ECS task and pass role from lambda
    if ( runTaskLambda.role && prCreationTask.executionRole) {
      runTaskLambda.role.addManagedPolicy( iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
      runTaskLambda.role.attachInlinePolicy(new iam.Policy(this,'policy', {
        statements: [ new iam.PolicyStatement( {
          sid: 'AllowECSTaskRun',
          effect: iam.Effect.ALLOW,
          actions: [ 'ecs:RunTask'],
          resources: [ prCreationTask.taskDefinitionArn ]
        })]
      }));
      runTaskLambda.role.attachInlinePolicy(new iam.Policy(this,'PassRolePolicy', {
        statements: [ new iam.PolicyStatement( {
          sid: 'PassExecutionRole',
          effect: iam.Effect.ALLOW,
          actions: [ 'iam:PassRole'],
          resources: [ prCreationTask.taskRole.roleArn, prCreationTask.executionRole.roleArn ]
        })]
      }));
      codeCommitRepo.grantPullPush(runTaskLambda.role);
    }

    // Trigger Lambda on EventBridge event
    onLibraryReleaseRule.addTarget(
        new targets.LambdaFunction( runTaskLambda,{
          event: events.RuleTargetInput.fromObject({
            groupId: events.EventField.fromPath('$.detail.packageNamespace'),
            artifactId: events.EventField.fromPath('$.detail.packageName'),
            version: events.EventField.fromPath('$.detail.packageVersion'),
            repoUrl: codeCommitRepo.repositoryCloneUrlHttp,
            region: this.region
          })
        }));

    const codeArtifactDomain = 'codeartifact-domain';
    const codeArtifactTokenCommand=`export CODEARTIFACT_TOKEN=$(aws codeartifact get-authorization-token --domain ${codeArtifactDomain} --domain-owner ${producerAccount} --query authorizationToken --output text)`

    // setup build project which build the consumer library
    const codeBuild = new codebuild.Project(this, 'CodeBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        environmentVariables: {
          'CODE_ARTIFACT_DOMAIN': { value: codeArtifactDomain },
          'CODE_ARTIFACT_ACCOUNT' : { value: producerAccount},
          'CODE_ARTIFACT_REGION': { value: this.region }
        }
      },
      source: codebuild.Source.codeCommit({repository: codeCommitRepo}),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              codeArtifactTokenCommand
            ]
          },
          build: {
            commands: [
              'mvn package --settings ./settings.xml'
            ],
          },
        },
      }),
    });

    codeBuild.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeArtifactReadOnlyAccess'));

    // trigger build when a PR is created with a branch prefixed 'library_update_'
    const onPullRequestCreatedRule = new events.Rule(this, 'PullRequestCreatedRule', {
      eventPattern: {
        source: [ 'aws.codecommit' ],
        detailType: [ 'CodeCommit Pull Request State Change' ],
        resources: [codeCommitRepo.repositoryArn],
        detail: {
          event: ['pullRequestCreated'],
          sourceReference: [{
            prefix: 'refs/heads/library_update_'
          }],
          destinationReference: ['refs/heads/main']
        }
      }
    });

    onPullRequestCreatedRule.addTarget( new targets.CodeBuildProject(codeBuild, {
      event: events.RuleTargetInput.fromObject( {
        projectName: codeBuild.projectName,
        sourceVersion: events.EventField.fromPath('$.detail.sourceReference')
      })
    }));

    // notify producer account if build fails
    const onFailedBuildRule = new events.Rule(this, 'BrokenBuildRule', {
      eventPattern: {
        detailType: ['CodeBuild Build State Change'],
        source: ['aws.codebuild'],
        detail: {
          'build-status': ['FAILED']
        }
      }
    });

    const producerAccountTarget = new targets.EventBus(events.EventBus.fromEventBusArn(this, 'cross-account-event-bus', `arn:aws:events:${this.region}:${producerAccount}:event-bus/default`))
    onFailedBuildRule.addTarget(producerAccountTarget);
  }
}
