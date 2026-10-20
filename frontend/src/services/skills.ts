import { natsService } from './nats';
import type { SkillSummary } from '@/types/skills';

export const skillsService = {
  list: async (): Promise<SkillSummary[]> => {
    return (await natsService.invoke('skills_list')).skills;
  },

  listOrg: async (): Promise<SkillSummary[]> => {
    return (await natsService.invoke('org_skills_list')).skills;
  },

  getManifest: async (name: string): Promise<string> => {
    return (await natsService.invoke('skill_get_manifest', { name })).manifest;
  },
} as const;
