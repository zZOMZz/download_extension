import type { MediaCandidate } from '../../shared/media';

export interface RequestHeaderModification {
  header: string;
  operation: 'set';
  value: string;
}

export interface SiteRequestRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders: RequestHeaderModification[];
  };
  condition: {
    tabIds: number[];
    initiatorDomains: string[];
    requestDomains: string[];
    resourceTypes: Array<'xmlhttprequest' | 'media' | 'other'>;
  };
}

export interface SiteRequestAdapter {
  readonly id: string;
  createSessionRules(
    candidate: MediaCandidate,
    downloaderTabId: number,
    extensionId: string,
    ruleId: number,
  ): SiteRequestRule[];
  createManagerSessionRules?(
    managerTabId: number,
    extensionId: string,
    ruleId: number,
  ): SiteRequestRule[];
}
