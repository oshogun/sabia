import { apiFetch, reportUnauthorized } from '../utils/api';
import { notifyMutation } from './mutations';
import type {
  PlannedLegImportResponse, PlannedLegListItem, PlannedLegWithChildren, SimbriefImportResponse,
} from '../types';

export function listPlannedLegs(): Promise<PlannedLegListItem[]> {
  return apiFetch<PlannedLegListItem[]>('/api/planned-legs');
}

export function getPlannedLeg(id: number): Promise<PlannedLegWithChildren> {
  return apiFetch<PlannedLegWithChildren>(`/api/planned-legs/${id}`);
}

export async function setPlannedLegStatus(
  legId: number, status: 'planned' | 'skipped' | 'flown',
): Promise<PlannedLegWithChildren> {
  const leg = await apiFetch<PlannedLegWithChildren>(`/api/planned-legs/${legId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  notifyMutation();
  return leg;
}

/** Moves a planned leg into another trip, or `null` to make it a loose leg. */
export async function movePlannedLeg(
  legId: number, tripId: number | null,
): Promise<PlannedLegWithChildren> {
  const leg = await apiFetch<PlannedLegWithChildren>(`/api/planned-legs/${legId}/trip`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tripId }),
  });
  notifyMutation();
  return leg;
}

export async function reorderPlannedLegs(
  tripId: number, legIds: number[],
): Promise<PlannedLegWithChildren[]> {
  const legs = await apiFetch<PlannedLegWithChildren[]>(`/api/trips/${tripId}/planned-legs/order`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legIds }),
  });
  notifyMutation();
  return legs;
}

export async function deletePlannedLeg(legId: number): Promise<void> {
  await apiFetch(`/api/planned-legs/${legId}`, { method: 'DELETE' });
  notifyMutation();
}

/**
 * Raw fetch, not apiFetch: a partial-failure batch answers with a non-2xx
 * status AND a full results[] body that must still be rendered, and apiFetch
 * discards the body on a non-2xx. A 401 is routed through the unauthorized
 * handler by hand, since apiFetch would normally do that itself.
 */
export async function importPlannedLegs(
  files: File[], tripId?: number,
): Promise<PlannedLegImportResponse> {
  const formData = new FormData();
  for (const file of files) formData.append('lnmpln', file);

  const url = tripId != null ? `/api/trips/${tripId}/planned-legs` : '/api/planned-legs';
  const res = await fetch(url, { method: 'POST', body: formData });
  const body = await res.json().catch(() => null) as (PlannedLegImportResponse & { error?: string }) | null;

  if (!res.ok) {
    if (res.status === 401) throw reportUnauthorized(body?.error);
    if (!body || !Array.isArray(body.results)) {
      throw new Error(body?.error ?? res.statusText);
    }
    // A partial-failure batch: the body is the real payload, not an error.
  } else if (!body) {
    throw new Error(res.statusText || 'invalid server response');
  }

  // Only notify if something actually landed — an all-rejected batch (the
  // only way a non-2xx response reaches here) changed nothing.
  if (body.imported.length > 0) notifyMutation();
  return body;
}

export async function importSimbriefLeg(tripId?: number): Promise<SimbriefImportResponse> {
  const url = tripId != null ? `/api/trips/${tripId}/planned-legs/simbrief` : '/api/planned-legs/simbrief';
  const body = await apiFetch<SimbriefImportResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow_duplicates: false }),
  });
  // A duplicate is a 2xx with result.status === 'duplicate' and nothing
  // changed server-side, so notifyMutation only fires on an actual import.
  if (body.result.status === 'imported') notifyMutation();
  return body;
}
