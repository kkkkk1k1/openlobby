import type { ChannelProvider, ChannelProviderConfig } from '@openlobby/core';
import { WeComBotProvider } from './wecom.js';

export function createProvider(config: ChannelProviderConfig): ChannelProvider {
  switch (config.channelName) {
    case 'wecom':
      return new WeComBotProvider(config);
    default:
      throw new Error(`Unknown channel provider: ${config.channelName}`);
  }
}

export { WeComBotProvider } from './wecom.js';
