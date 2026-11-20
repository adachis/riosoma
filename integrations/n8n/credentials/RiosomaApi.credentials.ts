import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from 'n8n-workflow';

/** A Riosoma server's address and a personal access token made in its settings. */
export class RiosomaApi implements ICredentialType {
  name = 'riosomaApi';

  displayName = 'Riosoma API';

  icon: Icon = { light: 'file:../icons/riosoma.svg', dark: 'file:../icons/riosoma.dark.svg' };

  documentationUrl = 'https://github.com/adachis/riosoma/tree/main/integrations/n8n#credentials';

  properties: INodeProperties[] = [
    {
      displayName: 'Address',
      name: 'url',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://riosoma.example.com',
      description: 'The address you open Riosoma at',
    },
    {
      displayName: 'Personal Access Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'A token from Riosoma, under Settings, then Personal access tokens.  Reading takes the Read records and Read tables, fields, and views scopes, writing takes Add, change, and delete records, and the trigger takes Change tables, fields, and views.',
    },
    {
      displayName: 'Ignore SSL Issues (Insecure)',
      name: 'ignoreSslIssues',
      type: 'boolean',
      default: false,
      description:
        "Whether to connect even when the certificate can't be checked, such as on a server with a certificate from its own authority",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.token}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.url.trim().replace(/\\/+$/, "").replace(/\\/api\\/v1$/, "")}}/api/v1',
      url: '/databases',
      skipSslCertificateValidation: '={{$credentials.ignoreSslIssues}}',
    },
  };
}
