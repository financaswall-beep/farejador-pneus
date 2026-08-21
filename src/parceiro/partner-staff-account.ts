export interface PartnerTokenRow {
  id: string;
  label: string | null;
  username: string | null;
  role: string;
  job_role: 'vendedor' | 'estoque' | 'entregador' | 'colaborador';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedFuncionario {
  id: string;
  label: string | null;
  username: string;
  created_at: string;
}

export class PartnerUsernameConflictError extends Error {
  readonly code = 'username_taken';
  constructor() {
    super('username_taken');
  }
}

export function assertStrongNewPassword(password: string): void {
  if (password.length < 12) throw new Error('password_too_short');
}

export function isUsernameConflict(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
    && String((err as { constraint?: string })?.constraint ?? '').includes('username');
}
