import { apiFetch } from '../utils/api';
import { notifyMutation } from './mutations';
import type {
  ChangePasswordResponse, IngestTokenCreateResponse, IngestTokenListResponse,
  McpTokenCreateResponse, McpTokenListResponse, SayIntentionsSettings, SimbriefSettings,
} from '../types';

export function getSimbriefSettings(): Promise<SimbriefSettings> {
  return apiFetch<SimbriefSettings>('/api/settings/simbrief');
}

export async function saveSimbriefSettings(userId: string | null): Promise<SimbriefSettings> {
  const settings = await apiFetch<SimbriefSettings>('/api/settings/simbrief', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ simbrief_user_id: userId }),
  });
  notifyMutation();
  return settings;
}

export function getSayIntentionsSettings(): Promise<SayIntentionsSettings> {
  return apiFetch<SayIntentionsSettings>('/api/settings/sayintentions');
}

export async function saveSayIntentionsKey(key: string): Promise<SayIntentionsSettings> {
  const settings = await apiFetch<SayIntentionsSettings>('/api/settings/sayintentions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sayintentions_api_key: key }),
  });
  notifyMutation();
  return settings;
}

/** Not a separate endpoint: same route as saveSayIntentionsKey, null value. */
export async function clearSayIntentionsKey(): Promise<SayIntentionsSettings> {
  const settings = await apiFetch<SayIntentionsSettings>('/api/settings/sayintentions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sayintentions_api_key: null }),
  });
  notifyMutation();
  return settings;
}

// None of the functions below call notifyMutation(): no other page shows tokens or the password.

export function getIngestTokens(): Promise<IngestTokenListResponse> {
  return apiFetch<IngestTokenListResponse>('/api/settings/ingest-tokens');
}

export function createIngestToken(label: string): Promise<IngestTokenCreateResponse> {
  return apiFetch<IngestTokenCreateResponse>('/api/settings/ingest-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
}

export function revokeIngestToken(id: number): Promise<IngestTokenListResponse> {
  return apiFetch<IngestTokenListResponse>(`/api/settings/ingest-tokens/${id}`, { method: 'DELETE' });
}

export function getMcpTokens(): Promise<McpTokenListResponse> {
  return apiFetch<McpTokenListResponse>('/api/settings/mcp-tokens');
}

export function createMcpToken(label: string): Promise<McpTokenCreateResponse> {
  return apiFetch<McpTokenCreateResponse>('/api/settings/mcp-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
}

export function revokeMcpToken(id: number): Promise<McpTokenListResponse> {
  return apiFetch<McpTokenListResponse>(`/api/settings/mcp-tokens/${id}`, { method: 'DELETE' });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<ChangePasswordResponse> {
  return apiFetch<ChangePasswordResponse>('/api/settings/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}
