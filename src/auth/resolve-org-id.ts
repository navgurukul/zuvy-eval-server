import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

type OrgAwareRequest = Request & {
  user?: { orgId?: number | string | null; [key: string]: unknown };
};

function parseOrgId(value: unknown): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return undefined;
  }
  return n;
}

/**
 * Tenant org for the request.
 * Regular roles: JWT `orgId`.
 * Super admin has no org on the token — pass `?orgId=` after switch-org.
 */
export function resolveOrgId(req: OrgAwareRequest): number {
  const fromToken = parseOrgId(req.user?.orgId);
  const fromQuery = parseOrgId(req.query?.orgId);
  const orgId = fromToken ?? fromQuery;

  if (!orgId) {
    throw new BadRequestException(
      'orgId is required. Super admin must pass orgId as a query param.',
    );
  }
  return orgId;
}
