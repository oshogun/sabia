import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Button, InlineLoading, InlineNotification, Link } from '@carbon/react';
import { UnauthorizedError } from '../utils/api';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import {
  getFlightAcars, getPlannedLeg, getPlannedLegAcars, getSayIntentionsLink, getSayIntentionsSettings,
  importSayIntentions, linkSayIntentions, listCannedMessages, pushClearanceToSayIntentions, requestAcarsPair,
  requestWx, sendCannedAcars, unlinkSayIntentions,
} from '../api';
import { useLiveEvent } from '../shell/LiveEventsProvider';
import type {
  AcarsHint, AcarsMessage, AcarsThread, CannedAcarsMessage, PlannedLegWithChildren, SayIntentionsLinkStatus,
} from '../types';
import { MessageCard } from './acars/MessageCard';
import { SayIntentionsPanel } from './acars/SayIntentionsPanel';
import {
  CLEARANCE_SENDING_ID, LOADSHEET_SENDING_ID, SendToolbar, SI_IMPORT_SENDING_ID, SI_LINK_SENDING_ID,
  SI_PUSH_SENDING_ID, SI_UNLINK_SENDING_ID, WX_SENDING_ID,
} from './acars/SendToolbar';
import { mergeById } from './acars/thread';
import './acars/acars.scss';

export function AcarsMessages() {
  // Two mutually exclusive scopes on one page: a flight's own ACARS log (`id`),
  // or a planned leg's pre-flight log before any flight is linked (`legId`).
  const { id, legId } = useParams<{ id?: string; legId?: string }>();
  const scope: 'flight' | 'planned-leg' = legId != null ? 'planned-leg' : 'flight';
  const flightId = Number(id);
  const [messages, setMessages] = useState<AcarsMessage[]>([]);
  const [plannedLegId, setPlannedLegId] = useState<number | null>(scope === 'planned-leg' ? Number(legId) : null);
  const [plannedLeg, setPlannedLeg] = useState<PlannedLegWithChildren | null>(null);
  const [canned, setCanned] = useState<CannedAcarsMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [cannedError, setCannedError] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [wxIcao, setWxIcao] = useState('');
  // null covers both "not loaded yet" and "unavailable" (no key, or the fetch
  // itself failed): the flight-scoped panel renders the same muted line.
  const [siLinkStatus, setSiLinkStatus] = useState<SayIntentionsLinkStatus | null>(null);
  const [siMessage, setSiMessage] = useState('');
  // false: no key saved; null: the check has not completed. Separate from the
  // link status because the planned-leg scope has no link fetch, only this.
  const [siKeySet, setSiKeySet] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setCannedError('');
    setMessages([]);
    Promise.all([
      scope === 'planned-leg' ? getPlannedLegAcars(Number(legId)) : getFlightAcars(flightId),
      // The canned set is its own resource: if only it fails, the thread is
      // still worth rendering read-only. A 401 is re-thrown so the redirect
      // still happens through the main catch below.
      listCannedMessages().catch(err => {
        if (err instanceof UnauthorizedError) throw err;
        return null;
      }),
      // getSayIntentionsLink already swallows its own failure to null.
      scope === 'flight' ? getSayIntentionsLink(flightId) : Promise.resolve(null),
      getSayIntentionsSettings().catch(err => {
        if (err instanceof UnauthorizedError) throw err;
        return null;
      }),
    ])
      .then(([thread, cannedList, siStatus, siSettings]) => {
        if (cancelled) return;
        setMessages(thread.messages);
        setPlannedLegId(scope === 'planned-leg' ? Number(legId) : (thread as AcarsThread).planned_leg_id);
        if (cannedList) setCanned(cannedList.messages);
        else setCannedError('Canned messages unavailable');
        setSiLinkStatus(siStatus);
        setSiKeySet(siSettings ? siSettings.sayintentions_api_key_set : false);
      })
      .catch(err => {
        // A 401 has already triggered the redirect inside apiFetch; showing a
        // page error on the way out would just flash behind it.
        if (cancelled || err instanceof UnauthorizedError) return;
        setLoadError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, legId, scope, flightId]);

  // Convenience-only lookup for the REQUEST WX default and the back link: a
  // failure means no suggested ICAO, not a page error.
  useEffect(() => {
    if (plannedLegId === null) {
      setPlannedLeg(null);
      return;
    }
    let cancelled = false;
    getPlannedLeg(plannedLegId)
      .then(leg => { if (!cancelled) setPlannedLeg(leg); })
      .catch(err => {
        if (!(err instanceof UnauthorizedError)) setPlannedLeg(null);
      });
    return () => { cancelled = true; };
  }, [plannedLegId]);

  // Re-derive the default whenever the leg changes, but only while the user
  // has not typed anything, so a fetched leg cannot clobber mid-edit input.
  useEffect(() => {
    if (wxIcao !== '') return;
    if (plannedLeg?.destination_is_airport) setWxIcao(plannedLeg.destination_ident);
    else if (plannedLeg?.departure_is_airport) setWxIcao(plannedLeg.departure_ident);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedLeg]);

  const scopeArg = scope === 'planned-leg' ? { legId: Number(legId) } : { flightId };

  // Refetches the thread and merges by id: rows already on screen are replaced
  // in place and new ones added, so the list never blanks and scroll position
  // survives. Runs from the Refresh button and from a relevant live acars
  // hint or a stream reconnect. Only the button counts as `manual`: an
  // automatic run must not clear a send error the operator hasn't acted on
  // yet, so it's left in place until they click Refresh themselves or send
  // something that succeeds.
  async function refresh(opts: { manual?: boolean } = {}) {
    setRefreshing(true);
    if (opts.manual) setSendError('');
    try {
      const thread = scope === 'planned-leg' ? await getPlannedLegAcars(Number(legId)) : await getFlightAcars(flightId);
      setMessages(prev => mergeById(prev, thread.messages));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  // Per the acars hint's relevance rule: a flight thread cares about a hint
  // naming its own flight id, or naming the leg it's linked to (a leg-scoped
  // row belongs to the flight thread too); a planned-leg thread cares only
  // about hints naming that exact leg.
  const isRelevantHint = useCallback((hint: AcarsHint) => {
    if (scope === 'planned-leg') return hint.plannedLegId === Number(legId);
    return hint.flightId === flightId || (hint.plannedLegId !== null && hint.plannedLegId === plannedLegId);
  }, [scope, legId, flightId, plannedLegId]);

  useLiveEvent(['acars'], batch => {
    if (batch.reconnected || batch.events.some(e => isRelevantHint(e.data as AcarsHint))) refresh();
  });

  async function handleSend(cannedId: string) {
    setSendingId(cannedId);
    setSendError('');
    try {
      const created = await sendCannedAcars(scopeArg, cannedId);
      // The response is the row the server stored, so appending is all the
      // thread needs: nothing optimistic to reconcile if a send is rejected.
      setMessages(prev => [...prev, created]);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleLoadsheet() {
    if (plannedLegId === null) return;
    setSendingId(LOADSHEET_SENDING_ID);
    setSendError('');
    try {
      const r = await requestAcarsPair(plannedLegId, 'loadsheet');
      // A re-request returns the pair already in the thread, so it merges by id.
      setMessages(prev => mergeById(prev, [r.request, r.reply]));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleClearance() {
    if (plannedLegId === null) return;
    setSendingId(CLEARANCE_SENDING_ID);
    setSendError('');
    try {
      const r = await requestAcarsPair(plannedLegId, 'clearance');
      setMessages(prev => mergeById(prev, [r.request, r.reply]));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleWx() {
    setSendingId(WX_SENDING_ID);
    setSendError('');
    try {
      const r = await requestWx(scopeArg, wxIcao.trim().toUpperCase());
      // Every accepted WX call creates two brand-new rows, so a plain append.
      setMessages(prev => [...prev, r.request, r.reply]);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  // LINK and RELINK share the same call.
  async function handleSiLink() {
    setSendingId(SI_LINK_SENDING_ID);
    setSendError('');
    setSiMessage('');
    try {
      const r = await linkSayIntentions(flightId);
      setSiLinkStatus({ flight_id: flightId, linked: true, link: r.link, api_key_set: true });
      setSiMessage(`Linked to SayIntentions session ${r.link.upstream_flight_id ?? 'current'} — ${r.pending_messages} messages waiting.`);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleSiUnlink() {
    setSendingId(SI_UNLINK_SENDING_ID);
    setSendError('');
    setSiMessage('');
    try {
      await unlinkSayIntentions(flightId);
      setSiLinkStatus(prev => (prev ? { ...prev, linked: false, link: null } : prev));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleSiImport() {
    setSendingId(SI_IMPORT_SENDING_ID);
    setSendError('');
    setSiMessage('');
    try {
      const r = await importSayIntentions(flightId);
      // A repeat import with nothing new is a success and the merge a no-op.
      if (r.messages.length > 0) setMessages(prev => mergeById(prev, r.messages));
      setSiMessage(r.imported > 0 ? `Imported ${r.imported} message(s).` : 'No new messages.');
      // The import response carries the new cursor but not the link's
      // cumulative counters, so those are re-read rather than approximated —
      // this accessor already swallows its own failure to null, in which
      // case the last known status is simply left in place.
      const refreshed = await getSayIntentionsLink(flightId);
      if (refreshed) setSiLinkStatus(refreshed);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  async function handleSiPush() {
    if (plannedLegId === null) return;
    const pdc = messages.find(m => m.category === 'pdc' && m.direction === 'uplink' && m.label === 'PDC');
    if (!pdc) return;
    setSendingId(SI_PUSH_SENDING_ID);
    setSendError('');
    setSiMessage('');
    try {
      const r = await pushClearanceToSayIntentions(plannedLegId);
      // The new stored row is appended directly, not merged.
      setMessages(prev => [...prev, r.message]);
      setSiMessage(`Sent to SayIntentions: ${r.message.body}`);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSendError((err as Error).message);
    } finally {
      setSendingId(null);
    }
  }

  const title = scope === 'planned-leg' ? `ACARS messages — Planned leg #${legId}` : `ACARS messages — Flight #${id}`;

  // The planned-leg back link goes to the leg's trip once the leg has loaded;
  // until then, or with no trip, it falls back to a list page.
  const backLink = scope === 'planned-leg'
    ? (plannedLeg?.trip_id != null
      ? <Link as={RouterLink} to={`/trip/${plannedLeg.trip_id}`}>← Back to trip</Link>
      : <Link as={RouterLink} to={plannedLeg ? '/prefiles' : '/flights'}>{plannedLeg ? '← Back to prefiles' : '← Back to trip'}</Link>)
    : <Link as={RouterLink} to={`/flight/${id}`}>← Flight #{id}</Link>;

  if (loadError) {
    const notFound = /not found/i.test(loadError);
    return (
      <>
        <div style={{ marginBottom: '1rem' }}>{backLink}</div>
        <InlineNotification
          kind="error" role="alert" lowContrast hideCloseButton
          title={notFound ? (scope === 'planned-leg' ? 'Planned leg not found' : 'Flight not found') : 'Could not load messages'}
          subtitle={notFound ? undefined : loadError}
        />
      </>
    );
  }

  // Newest at top. A copy, never messages.reverse(): state stays oldest-first,
  // the order the API returns and the order an appended message belongs in.
  const ordered = [...messages].reverse();
  const hasPdcUplink = messages.some(m => m.category === 'pdc' && m.direction === 'uplink' && m.label === 'PDC');

  return (
    <div id="acars-messages">
      <div style={{ marginBottom: '1rem' }}>{backLink}</div>
      <PageHeader
        title={title}
        subtitle={`${messages.length} messages${scope === 'flight' && plannedLegId != null ? ` · including planned leg ${plannedLegId}` : ''}`}
        actions={loading ? undefined : (
          <Button kind="tertiary" size="md" disabled={refreshing} onClick={() => refresh({ manual: true })}>
            {refreshing ? <InlineLoading description="Refreshing…" /> : 'Refresh'}
          </Button>
        )}
      />

      {loading ? (
        <InlineLoading description="Loading messages…" />
      ) : (
        <div className="acars-stack">
          <SendToolbar
            canned={canned} cannedError={cannedError} sendingId={sendingId}
            plannedLegId={plannedLegId} plannedLeg={plannedLeg}
            wxIcao={wxIcao} onWxIcaoChange={setWxIcao}
            siKeySet={siKeySet} hasPdcUplink={hasPdcUplink}
            sendError={sendError} siMessage={siMessage}
            onSend={handleSend} onLoadsheet={handleLoadsheet} onClearance={handleClearance}
            onPush={handleSiPush} onWx={handleWx}
          />
          {scope === 'flight' && (
            <SayIntentionsPanel
              status={siLinkStatus} sendingId={sendingId}
              onLink={handleSiLink} onUnlink={handleSiUnlink} onImport={handleSiImport}
            />
          )}
          <section aria-label="Thread">
            {ordered.length === 0 ? (
              <EmptyState
                title="No messages yet"
                description={scope === 'planned-leg'
                  ? 'ACARS messages sent or received for this planned leg appear here.'
                  : 'ACARS messages sent or received for this flight appear here.'}
              />
            ) : (
              <div className="acars-thread">
                {ordered.map(m => <MessageCard key={m.id} message={m} />)}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
