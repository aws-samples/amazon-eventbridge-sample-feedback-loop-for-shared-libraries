const AWS = require('aws-sdk');

const ECS = new AWS.ECS();
exports.handler = async (event) => {
    console.log(`Received event: ${JSON.stringify(event)}`)
    const artifactVersion = event.version;
    const artifactId = event.artifactId;
    if ( artifactVersion.indexOf('SNAPSHOT') > -1 ) {
        console.log(`Skipping SNAPSHOT version ${artifactVersion}`)
    } else {
        console.log(`Triggering task to create pull request for version ${artifactVersion} of artifact ${artifactId}`);
        const params = {
            launchType: 'FARGATE',
            taskDefinition: process.env.TASK_DEFINITION_ARN,
            cluster: process.env.CLUSTER_ARN,
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: process.env.TASK_SUBNETS.split(',')
                }
            },
            overrides: {
                containerOverrides: [{
                    name: process.env.CONTAINER_NAME,
                    environment: [
                        {name: 'REPO_URL', value: process.env.REPO_URL},
                        {name: 'REPO_NAME', value: process.env.REPO_NAME},
                        {name: 'REPO_REGION', value: process.env.REPO_REGION},
                        {name: 'ARTIFACT_VERSION', value: artifactVersion},
                        {name: 'ARTIFACT_ID', value: artifactId}
                    ]
                }]
            }
        };
        await ECS.runTask(params).promise();
    }
};
