#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ConsumerStack } from '../lib/consumer-stack';
import {ProducerStack} from "../lib/producer-stack";

const app = new cdk.App();

const consumerAccount = app.node.tryGetContext('consumerAccount');
const producerAccount = app.node.tryGetContext('producerAccount');
const region = app.node.tryGetContext('region');

if ( !consumerAccount || !producerAccount ) {
    throw new Error('Please provide "consumerAccount", "producerAccount" and "region" via --context')
}

const consumerStack = new ConsumerStack(app, 'ConsumerStack', {
    env: { account: consumerAccount, region: region },
    producerAccount: producerAccount
});

new ProducerStack(app, 'ProducerStack', {
    env: { account: producerAccount, region: region },
    consumerAccount: consumerAccount
}).addDependency(consumerStack);


