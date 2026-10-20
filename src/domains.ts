import type { APIApplicationDomain, UserPlanName } from "@vertracloud/api-types/v1";

export function primaryDomain(domains: readonly APIApplicationDomain[] | undefined): APIApplicationDomain | undefined {
  return domains?.find((d) => d.companion_of === null && d.redirect_to === null);
}

export function domainLabel(domain: APIApplicationDomain): string {
  const port = domain.port === 80 ? "" : `:${domain.port}`;
  return `${domain.hostname}${port}${domain.path_prefix ?? ""}`;
}

export function planLabel(name: UserPlanName): string {
  const [head = "", size] = name.split("-");
  const base = head.charAt(0).toUpperCase() + head.slice(1);
  return size ? `${base} ${size}` : base;
}
