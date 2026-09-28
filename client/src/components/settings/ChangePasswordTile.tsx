import { useState } from 'react';
import { Button, Form, InlineNotification, PasswordInput, Stack, Tile } from '@carbon/react';
import { changePassword } from '../../api';
import { UnauthorizedError } from '../../utils/api';

/** Mirrors the server's PASSWORD_MIN_LENGTH; the server remains authoritative. */
const MIN_PASSWORD_LENGTH = 12;

/** Operator login password: current-password confirmation, then a new one. */
export function ChangePasswordTile() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const canSubmit = current !== '' && next !== '' && confirm !== '' && !submitting;

  async function submit() {
    setError(''); setSuccess('');
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSubmitting(true);
    try {
      const r = await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setSuccess(`Password changed. ${r.other_sessions_revoked} other session(s) were signed out.`);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Tile data-testid="password-tile">
      <Form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <Stack gap={5}>
          <h2 className="sabia-heading-03">Operator password</h2>
          <PasswordInput
            id="settings-current-password" labelText="Current password" autoComplete="current-password"
            value={current} disabled={submitting} onChange={e => { setCurrent(e.target.value); setMismatch(false); }}
          />
          <PasswordInput
            id="settings-new-password" labelText="New password" autoComplete="new-password"
            helperText="At least 12 characters." value={next} disabled={submitting}
            onChange={e => { setNext(e.target.value); setMismatch(false); }}
          />
          <PasswordInput
            id="settings-confirm-password" labelText="Confirm new password" autoComplete="new-password"
            value={confirm} disabled={submitting} onChange={e => { setConfirm(e.target.value); setMismatch(false); }}
          />
          {mismatch && (
            <InlineNotification kind="error" lowContrast hideCloseButton data-testid="password-mismatch" title="Passwords do not match." />
          )}
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not change password" subtitle={error} />}
          {success && <InlineNotification kind="success" lowContrast hideCloseButton title={success} />}
          <div>
            <Button type="submit" kind="primary" disabled={!canSubmit} data-testid="password-submit">
              {submitting ? 'Changing…' : 'Change password'}
            </Button>
          </div>
        </Stack>
      </Form>
    </Tile>
  );
}
