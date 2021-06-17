FROM amazon/aws-cli

RUN yum -y install git && \
    git config --system credential.helper '!aws codecommit credential-helper $@' && \
    git config --system credential.UseHttpPath true

WORKDIR /tmp

COPY createPullRequest.sh /tmp

USER 1001

ENTRYPOINT ["/tmp/createPullRequest.sh"]