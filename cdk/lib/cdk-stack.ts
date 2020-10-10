import * as CodeBuild from '@aws-cdk/aws-codebuild';
import * as CodePipeline from '@aws-cdk/aws-codepipeline';
import * as CodePipelineActions from '@aws-cdk/aws-codepipeline-actions';
import * as Iam from '@aws-cdk/aws-iam';
import * as SecretsManager from '@aws-cdk/aws-secretsmanager';
import * as Cdk from '@aws-cdk/core';

interface CdkStackProps extends Cdk.StackProps {
  secretArn: string;
  backendStackName: string;
}

export class CdkStack extends Cdk.Stack {
  private props: CdkStackProps;

  constructor(scope: Cdk.Construct, id: string, props: CdkStackProps) {
    super(scope, id, props);
    this.props = props;

    new CodePipeline.Pipeline(this, 'Omnisha.dePipeline', {
      restartExecutionOnUpdate: true,
      stages: this.renderPipelineStages(),
    });
  }

  private renderSelfMutateProject = (): CodeBuild.PipelineProject => {
    const project = new CodeBuild.PipelineProject(this, 'SelfMutateProject', {
      buildSpec: CodeBuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['chmod +x cdk/bin/*'],
          },
          build: {
            commands: [`./cdk/bin/build_code.sh`],
          },
        },
        artifacts: {
          'base-directory': 'cdk',
          files: ['cdk.out/**/*', 'bin/*', 'package.json'],
        },
      }),
      environment: {
        buildImage: CodeBuild.LinuxBuildImage.STANDARD_4_0,
      },
    });

    const secretPolicy = new Iam.PolicyStatement();
    secretPolicy.addActions('secretsmanager:DescribeSecret');
    secretPolicy.addResources(this.props.secretArn);
    project.addToRolePolicy(secretPolicy);

    return project;
  };

  private renderDeployBackend = (): CodeBuild.PipelineProject => {
    const project = new CodeBuild.PipelineProject(this, 'DeployBackendProject', {
      buildSpec: CodeBuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [`./bin/deploy_backend.sh ${this.props.backendStackName}`],
          },
        },
      }),
      environment: {
        buildImage: CodeBuild.LinuxBuildImage.STANDARD_4_0,
      },
    });

    const cloudformationPolicy = new Iam.PolicyStatement();
    cloudformationPolicy.addActions('*');
    cloudformationPolicy.addResources('*');
    project.addToRolePolicy(cloudformationPolicy);

    return project;
  };

  private renderPipelineStages = (): CodePipeline.StageProps[] => {
    const sourceOutput = new CodePipeline.Artifact();
    const sourceAuth = SecretsManager.Secret.fromSecretArn(
      this, 
      'GithubSecret', 
      this.props.secretArn
      ).secretValueFromJson('OAuth');

    const selfMutateOutput = new CodePipeline.Artifact();

    return [
      {
        stageName: 'GithubSource',
        actions: [
          new CodePipelineActions.GitHubSourceAction({
            actionName: 'GithubSource',
            oauthToken: sourceAuth,
            output: sourceOutput,
            owner: 'Omnishade',
            repo: 'omnisha.de',
            branch: 'master',
          }),
        ],
      },
      {
        stageName: 'SelfMutate',
        actions: [
          new CodePipelineActions.CodeBuildAction({
            actionName: 'SelfMutateRender',
            input: sourceOutput,
            outputs: [selfMutateOutput],
            project: this.renderSelfMutateProject(),
            runOrder: 1,
          }),
          new CodePipelineActions.CloudFormationCreateUpdateStackAction({
            actionName: 'SelfMutateDeploy',
            adminPermissions: true,
            stackName: this.stackName,
            templatePath: selfMutateOutput.atPath(`cdk.out/${this.stackName}.template.json`),
            runOrder: 2,
          }),
        ],
      },
      // Add testing stage here if desired
      {
        stageName: 'DeployBackend',
        actions: [
          new CodePipelineActions.CodeBuildAction({
            actionName: 'DeployBackend',
            input: selfMutateOutput, 
            project: this.renderDeployBackend(),
          }),
        ],
      },
    ];
  };
}
