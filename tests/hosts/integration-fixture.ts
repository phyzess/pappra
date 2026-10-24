import {
  HostIntegrationService,
  type HostIntegrationOptions,
} from '../../src/hosts/integration/service.js';

/** Explicit version-observation port for filesystem ownership fixtures. */
export class FixtureHostIntegrationService extends HostIntegrationService {
  constructor(options: HostIntegrationOptions) {
    super({
      ...options,
      versionProbe: options.versionProbe ?? (() => options.hostVersion ?? null),
    });
  }
}
