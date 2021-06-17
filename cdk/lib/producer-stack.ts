import * as cdk from '@aws-cdk/core';
import * as core from '@aws-cdk/core';
import * as codeartifact from '@aws-cdk/aws-codeartifact';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as sns from '@aws-cdk/aws-sns';

interface ProducerStackProps extends cdk.StackProps {
  consumerAccount: string
}

export class ProducerStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);

    const consumerAccount = props?.consumerAccount;

    // Allow the consumer account to put events into this account's eventbus (needed for SNS notification on failed builds)
    new events.CfnEventBusPolicy(this, 'EventBusPolicy', {
      statementId: 'AllowCrossAccount',
      action: 'events:PutEvents',
      principal: consumerAccount
    });

    // allow the consumer account to read the codeartifact repo
    const codeArtifactDomain = new codeartifact.CfnDomain(this, 'SharedLibraryCodeArtifactDomain', {
      domainName: 'codeartifact-domain',
      permissionsPolicyDocument: {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Action": [
              "codeartifact:GetAuthorizationToken",
              "codeartifact:ReadFromRepository"
            ],
            "Effect": "Allow",
            "Principal": {
              "AWS": `${consumerAccount}`
            },
            "Resource": "*"
          }
        ]
      }
    });

    const codeArtifactRepo = new codeartifact.CfnRepository(this, 'SharedLibraryCodeArtifact', {
      repositoryName: 'codeartifact',
      domainName: codeArtifactDomain.domainName
    });
    codeArtifactRepo.addDependsOn(codeArtifactDomain);

    // setup event in consumer account on a new library release
    const onLibraryReleaseRule = new events.Rule(this, 'LibraryReleaseRule', {
      eventPattern: {
        source: [ 'aws.codeartifact' ],
        detailType: [ 'CodeArtifact Package Version State Change' ],
        detail: {
          domainOwner: [ this.account ],
          domainName: [ codeArtifactDomain.domainName ],
          repositoryName: [ codeArtifactRepo.repositoryName ],
          packageVersionState: ['Published'],
          packageFormat: ['maven']
        }
      }
    });

    // there is currently no CDK construct provided to add an event bus in another account as a target. That why we use the underlying CfnRule directly
    const cfnRule = onLibraryReleaseRule.node.defaultChild as events.CfnRule;
    cfnRule.targets = [{arn: `arn:aws:events:${this.region}:${consumerAccount}:event-bus/default`, id: 'ConsumerAccount'}];


    //setup notification to SNS on a failed build on the consumer account
    const notificationTopic = new sns.Topic(this, 'BrokenDownstreamBuildTopic', {
      topicName: 'BrokenDownstreamBuildTopic'
    });

    // publish to SNS failed build events from the consumer account
    const onFailedBuildRule = new events.Rule(this, 'BrokenBuildRule', {
      eventPattern: {
        detailType: ['CodeBuild Build State Change'],
        source: ['aws.codebuild'],
        account: [ consumerAccount ],
        detail: {
          'build-status': ['FAILED']
        }
      }
    });
    onFailedBuildRule.addTarget(new targets.SnsTopic(notificationTopic));

    new core.CfnOutput(this, 'codeartifact-domain', {
      exportName: 'CODEARTIFACT-DOMAIN',
      value: `export CODEARTIFACT_DOMAIN=${codeArtifactDomain.domainName}`
    });

    new core.CfnOutput(this, 'codeartifact-account', {
      exportName: 'CODEARTIFACT-ACCOUNT',
      value: `export CODEARTIFACT_ACCOUNT=${this.account}`
    });

    new core.CfnOutput(this, 'codeartifact-region', {
      exportName: 'CODEARTIFACT-REGION',
      value: `export CODEARTIFACT_REGION=${this.region}`
    });
  }
}
