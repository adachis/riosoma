import { vaultAdapter, type CredentialVault } from './vault.js';
import { awsAdapter, azureAdapter, googleAdapter } from './cloud.js';
import { dopplerAdapter, infisicalAdapter, onepasswordAdapter } from './hosted.js';
import { bitwardenAdapter } from './bitwarden.js';
import type { VaultProfile } from './settings.js';

export function vaultFor(profile: VaultProfile): CredentialVault {
  switch (profile.kind) {
    case 'vault':
    case 'openbao':
      return vaultAdapter(profile);
    case 'aws':
      return awsAdapter(profile);
    case 'google':
      return googleAdapter(profile);
    case 'azure':
      return azureAdapter(profile);
    case 'infisical':
      return infisicalAdapter(profile);
    case 'doppler':
      return dopplerAdapter(profile);
    case 'bitwarden':
      return bitwardenAdapter(profile);
    case 'onepassword':
      return onepasswordAdapter(profile);
  }
}
