import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Accordion, AccordionItem, Button, Form, InlineNotification, Link, Select, SelectItem, Stack, Tag, TextInput, Tile,
} from '@carbon/react';
import { getCurrentGroundSession, getPlannedLeg, listPlannedLegs, setGroundSession } from '../../api';
import { UnauthorizedError } from '../../utils/api';
import { useLiveEvent } from '../../shell/LiveEventsProvider';
import type { GroundSession, PlannedLegListItem, PlannedLegWithChildren, Status } from '../../types';
import { formatDate } from '../../utils/format';

/** Same key as the production page, so the operator's choice carries over. */
const GROUND_SECTION_COLLAPSED_KEY = 'msfslogger.groundSectionCollapsed';

/** What the card renders, normalised from the live status or the fallback read. */
interface GroundCardView {
  source: 'auto' | 'manual';
  airportIcao: string | null;
  airportName: string | null;
  parkingPosition: string | null;
  plannedLegId: number | null;
  departureIdent: string | null;
  destinationIdent: string | null;
  startedAt: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GroundSection({ status }: { status: Status | null }) {
  const [current, setCurrent] = useState<GroundSession | null>(null);
  const [groundError, setGroundError] = useState<string | null>(null);
  const [legDetail, setLegDetail] = useState<PlannedLegWithChildren | null>(null);

  const [legOptions, setLegOptions] = useState<PlannedLegListItem[] | null>(null);
  const [legOptionsError, setLegOptionsError] = useState('');

  const [icao, setIcao] = useState('');
  const [stand, setStand] = useState('');
  const [legId, setLegId] = useState('');
  // A field the operator never touched is left out of the submission, so a
  // blank box cannot clear a value detection already resolved.
  const [standTouched, setStandTouched] = useState(false);
  const [legTouched, setLegTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [formOk, setFormOk] = useState('');

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(GROUND_SECTION_COLLAPSED_KEY) === 'true');
  useEffect(() => {
    localStorage.setItem(GROUND_SECTION_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  // A ref rather than a `cancelled` local: the live-stream refetch below and
  // the mount-time load share this one loader, so both need the same guard.
  // Set on mount, not just in the cleanup: StrictMode's dev-mode
  // mount-cleanup-mount would otherwise leave this false for good after the
  // second mount, dropping every result silently.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadCurrent = useCallback(
    () =>
      getCurrentGroundSession()
        .then(r => { if (mountedRef.current) { setCurrent(r.session); setGroundError(null); } })
        .catch(e => {
          if (e instanceof UnauthorizedError) return;
          if (mountedRef.current) setGroundError(errText(e));
        }),
    []
  );

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  useLiveEvent(['flights-changed', 'flight-state'], loadCurrent);

  useEffect(() => {
    let cancelled = false;
    listPlannedLegs()
      .then(all => { if (!cancelled) setLegOptions(all.filter(l => l.linked_flight_id === null)); })
      .catch(e => {
        if (e instanceof UnauthorizedError) return;
        if (!cancelled) setLegOptionsError(errText(e));
      });
    return () => { cancelled = true; };
  }, []);

  // The leg's route idents are only needed on the fallback path; the live
  // status already carries them.
  const manual = current?.source === 'manual';
  const fallbackLegId = !status?.groundSession || manual ? current?.planned_leg_id ?? null : null;
  useEffect(() => {
    if (fallbackLegId == null) { setLegDetail(null); return; }
    let cancelled = false;
    getPlannedLeg(fallbackLegId)
      .then(l => { if (!cancelled) setLegDetail(l); })
      .catch(() => { if (!cancelled) setLegDetail(null); });
    return () => { cancelled = true; };
  }, [fallbackLegId]);

  const live = status?.groundSession;
  // The operator's manual entry, held by the mock store, wins over live detection.
  const card: GroundCardView | null = (live && !manual
    ? {
        source: live.source, airportIcao: live.airportIcao, airportName: live.airportName,
        parkingPosition: live.parkingPosition, plannedLegId: live.plannedLegId,
        departureIdent: live.departureIdent, destinationIdent: live.destinationIdent, startedAt: live.startedAt,
      }
    : current
      ? {
          source: current.source, airportIcao: current.airport_icao, airportName: current.airport_name,
          parkingPosition: current.parking_position, plannedLegId: current.planned_leg_id,
          departureIdent: legDetail?.departure_ident ?? null, destinationIdent: legDetail?.destination_ident ?? null,
          startedAt: current.started_at,
        }
      : null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const code = icao.trim();
    if (!code) { setFormError('ICAO is required'); return; }
    setSubmitting(true);
    setFormError('');
    setFormOk('');
    try {
      await setGroundSession({
        icao: code.toUpperCase(),
        ...(standTouched ? { parking_position: stand.trim() || null } : {}),
        ...(legTouched ? { planned_leg_id: legId === '' ? null : Number(legId) } : {}),
      });
      // The POST returns the created row, but the card is driven from the
      // /current envelope everywhere else, so re-fetch it rather than swap shapes.
      const refreshed = await getCurrentGroundSession();
      setCurrent(refreshed.session);
      setGroundError(null);
      setFormOk(`Ground position set to ${code.toUpperCase()}.`);
      setIcao(''); setStand(''); setLegId(''); setStandTouched(false); setLegTouched(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setFormError(errText(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <Accordion>
        <AccordionItem
          title="Ground position"
          open={!collapsed}
          onHeadingClick={({ isOpen }) => setCollapsed(!isOpen)}
        >
          {groundError && (
            <InlineNotification kind="error" role="alert" title="Ground position unavailable" subtitle={groundError} hideCloseButton lowContrast />
          )}
          {card ? (
            <Tile data-testid="ground-card" style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Tag type={card.source === 'auto' ? 'blue' : 'gray'} size="md">
                  {card.source === 'auto' ? 'Detected' : 'Manual entry'}
                </Tag>
                <span className="sabia-heading-03">
                  {card.airportIcao ? `${card.airportIcao} — ${card.airportName || 'Unknown airport'}` : 'Airport not resolved'}
                </span>
              </div>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', color: 'var(--cds-text-secondary)' }}>
                <span>{card.parkingPosition || 'Stand not set'}</span>
                {card.plannedLegId != null && (
                  <Link as={RouterLink} to={`/planned-leg/${card.plannedLegId}/acars`}>
                    {card.departureIdent && card.destinationIdent
                      ? `${card.departureIdent} → ${card.destinationIdent}`
                      : `Planned leg #${card.plannedLegId}`}
                  </Link>
                )}
                <span>Since {formatDate(card.startedAt)}</span>
              </div>
            </Tile>
          ) : (
            <p style={{ color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>Not on the ground.</p>
          )}

          <Form onSubmit={handleSubmit} aria-label="Manual ground position entry">
            <Stack gap={5}>
              <div>
                <h2 className="sabia-heading-02">Manual entry (fallback)</h2>
                <p className="sabia-helper">
                  Sabiá detects your airport and stand automatically. Use this only when detection could not resolve your position.
                </p>
              </div>
              <TextInput
                id="ground-manual-icao" labelText="ICAO" placeholder="ICAO" maxLength={4}
                value={icao} disabled={submitting}
                onChange={e => setIcao(e.target.value)}
              />
              <TextInput
                id="ground-manual-stand" labelText="Ramp / gate" placeholder="Stand, gate or ramp" maxLength={120}
                value={stand} disabled={submitting}
                onChange={e => { setStand(e.target.value); setStandTouched(true); }}
              />
              <Select
                id="ground-manual-leg" labelText="Planned leg" value={legId} disabled={submitting}
                invalid={!!legOptionsError} invalidText={legOptionsError}
                onChange={e => { setLegId(e.target.value); setLegTouched(true); }}
              >
                <SelectItem value="" text="None" />
                {legOptions?.map(l => (
                  <SelectItem key={l.id} value={String(l.id)} text={`${l.trip_name ?? 'No trip'} · ${l.departure_ident} → ${l.destination_ident}`} />
                ))}
              </Select>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <Button type="submit" disabled={submitting || !icao.trim()}>
                  {submitting ? 'Setting…' : 'Set ground position'}
                </Button>
              </div>
              {formError && <InlineNotification kind="error" role="alert" title="Could not set position" subtitle={formError} hideCloseButton lowContrast />}
              {formOk && <InlineNotification kind="success" title="Saved" subtitle={formOk} hideCloseButton lowContrast />}
            </Stack>
          </Form>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
