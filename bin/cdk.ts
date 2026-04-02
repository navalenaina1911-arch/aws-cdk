import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NotesStack } from '../lib/notes-stack';

const app = new cdk.App();
new NotesStack(app, 'NotesStack', {
  env: {
    account: '119287771917',
    region: 'eu-north-1',
  },
});