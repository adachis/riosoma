import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { methods } from './methods';
import { execute } from './operations';
import { properties } from './properties';

export class Riosoma implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Riosoma',
    name: 'riosoma',
    icon: { light: 'file:../../icons/riosoma.svg', dark: 'file:../../icons/riosoma.dark.svg' },
    group: ['input', 'output'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Read and write records in a Riosoma database',
    defaults: { name: 'Riosoma' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: 'riosomaApi', required: true }],
    properties,
  };

  methods = methods;

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return execute.call(this);
  }
}
