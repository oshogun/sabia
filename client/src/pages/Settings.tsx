import { useEffect, useState } from 'react';
import { Button, Form, InlineNotification, PasswordInput, SkeletonText, Stack, TextInput, Tile } from '@carbon/react';
import { PageHeader } from '../components/PageHeader';
import {
  clearSayIntentionsKey, getSayIntentionsSettings, getSimbriefSettings, saveSayIntentionsKey, saveSimbriefSettings,
} from '../api';
import { UnauthorizedError } from '../utils/api';
import type { SayIntentionsSettings } from '../types';
import { IngestTokensTile } from '../components/settings/IngestTokensTile';
import { McpTokensTile } from '../components/settings/McpTokensTile';
import { ChangePasswordTile } from '../components/settings/ChangePasswordTile';

export function Settings() {
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [sbId, setSbId] = useState('');
  const [sbSaved, setSbSaved] = useState<string | null>(null);
  const [sbSaving, setSbSaving] = useState(false);
  const [sbError, setSbError] = useState('');
  const [sbOk, setSbOk] = useState('');

  const [siKey, setSiKey] = useState('');
  const [siSaved, setSiSaved] = useState<SayIntentionsSettings | null>(null);
  const [siSaving, setSiSaving] = useState(false);
  const [siError, setSiError] = useState('');
  const [siOk, setSiOk] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSimbriefSettings(), getSayIntentionsSettings()])
      .then(([sb, si]) => {
        if (cancelled) return;
        setSbSaved(sb.simbrief_user_id);
        setSbId(sb.simbrief_user_id ?? '');
        setSiSaved(si);
      })
      .catch(err => {
        if (cancelled || err instanceof UnauthorizedError) return;
        setLoadError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const sbDirty = sbId.trim() !== (sbSaved ?? '');

  async function saveSb() {
    setSbSaving(true); setSbError(''); setSbOk('');
    try {
      const r = await saveSimbriefSettings(sbId.trim() || null);
      setSbSaved(r.simbrief_user_id);
      setSbId(r.simbrief_user_id ?? '');
      setSbOk(r.simbrief_user_id ? 'SimBrief pilot ID saved.' : 'SimBrief pilot ID removed.');
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSbId(sbSaved ?? '');
      setSbError((err as Error).message);
    } finally {
      setSbSaving(false);
    }
  }

  async function saveSi() {
    setSiSaving(true); setSiError(''); setSiOk('');
    try {
      setSiSaved(await saveSayIntentionsKey(siKey.trim()));
      setSiKey('');
      setSiOk('SayIntentions API key saved.');
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSiError((err as Error).message);
    } finally {
      setSiSaving(false);
    }
  }

  async function clearSi() {
    setSiSaving(true); setSiError(''); setSiOk('');
    try {
      setSiSaved(await clearSayIntentionsKey());
      setSiOk('SayIntentions API key cleared.');
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSiError((err as Error).message);
    } finally {
      setSiSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" />
      {loadError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load settings" subtitle={loadError} />
      )}
      <Stack gap={6}>
        <Tile>
          <Form onSubmit={e => { e.preventDefault(); if (sbDirty) void saveSb(); }}>
            <Stack gap={5}>
              <h2 className="sabia-heading-03">SimBrief</h2>
              <p className="sabia-helper">The pilot ID is stored here; importing a SimBrief plan itself stays on Prefiles.</p>
              {loading ? <SkeletonText /> : (
                <TextInput
                  id="settings-simbrief-user-id"
                  labelText="SimBrief Pilot ID"
                  value={sbId}
                  disabled={sbSaving}
                  onChange={e => setSbId(e.target.value)}
                />
              )}
              {sbError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={sbError} />}
              {sbOk && <InlineNotification kind="success" lowContrast hideCloseButton title={sbOk} />}
              <div>
                <Button type="submit" kind="primary" disabled={loading || sbSaving || !sbDirty}>
                  {sbSaving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </Stack>
          </Form>
        </Tile>

        <Tile>
          <Form onSubmit={e => { e.preventDefault(); if (siKey) void saveSi(); }}>
            <Stack gap={5}>
              <h2 className="sabia-heading-03">SayIntentions</h2>
              <p className="sabia-helper">
                Optional. Enables importing SayIntentions comms into a flight&apos;s ACARS thread and sending a PDC into your live session.
                The key is write-only and never shown again.
              </p>
              {loading ? <SkeletonText /> : (
                <PasswordInput
                  id="settings-sayintentions-api-key"
                  labelText="SayIntentions API Key"
                  autoComplete="off"
                  value={siKey}
                  disabled={siSaving}
                  onChange={e => setSiKey(e.target.value)}
                />
              )}
              <p className="sabia-helper" data-testid="si-status">
                {loading ? 'Loading…' : siSaved?.sayintentions_api_key_set ? `Saved: ${siSaved.sayintentions_api_key_masked}` : 'No key saved'}
              </p>
              {siError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={siError} />}
              {siOk && <InlineNotification kind="success" lowContrast hideCloseButton title={siOk} />}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Button type="submit" kind="primary" disabled={loading || siSaving || !siKey}>
                  {siSaving ? 'Saving…' : 'Save'}
                </Button>
                {siSaved?.sayintentions_api_key_set && (
                  <Button type="button" kind="danger--ghost" disabled={siSaving} onClick={clearSi}>Clear</Button>
                )}
              </div>
            </Stack>
          </Form>
        </Tile>

        <IngestTokensTile />
        <McpTokensTile />
        <ChangePasswordTile />
      </Stack>
    </>
  );
}
