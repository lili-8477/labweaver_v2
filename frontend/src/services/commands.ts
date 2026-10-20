import { natsService } from './nats';
import type { CommandSummary } from '@/types/commands';

export const commandsService = {
  list: async (): Promise<CommandSummary[]> => {
    return (await natsService.invoke('commands_list')).commands;
  },
} as const;
