#!/usr/bin/env bash
set -e

# clone the repository and create a new branch for the change
git clone --depth 1 $REPO_URL repo && cd repo
branch="library_update_$(date +"%Y-%m-%d_%H-%M-%S")"
git checkout -b "$branch"

# replace whatever version is currently used by the new version of the library
sed -i "s/<shared\.library\.version>.*<\/shared\.library\.version>/<shared\.library\.version>${ARTIFACT_VERSION}<\/shared\.library\.version>/g" pom.xml

# stage, commit and push the change
git add pom.xml
git -c "user.name=ECS Pull Request Creator" -c "user.email=noreply@example.com" commit -m "Update version of ${ARTIFACT_ID} to ${ARTIFACT_VERSION}"
git push --set-upstream origin "$branch"

# create pull request
aws codecommit create-pull-request --title "Update version of ${ARTIFACT_ID} to ${ARTIFACT_VERSION}" --targets repositoryName="$REPO_NAME",sourceReference="$branch",destinationReference=main --region "$REPO_REGION"
