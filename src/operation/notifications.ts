export type OperationNoticeKind = 'delivery' | 'finance' | 'stock' | 'system';

export interface OperationSystemNotice {
  id: string;
  kind: OperationNoticeKind;
  title: string;
  description: string;
  badge: string;
  target: 'deliveries' | 'finance' | 'stock' | 'none';
  priority: 'normal' | 'attention';
}
