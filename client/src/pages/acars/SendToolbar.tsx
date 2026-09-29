import { Link as RouterLink } from 'react-router-dom';
import { Button, InlineLoading, InlineNotification, Link, TextInput, Tile } from '@carbon/react';
import type { CannedAcarsMessage, PlannedLegWithChildren } from '../../types';
import { isPlausibleIcao } from './thread';
import './acars.scss';

export const LOADSHEET_SENDING_ID = 'loadsheet';
export const CLEARANCE_SENDING_ID = 'clearance';
export const WX_SENDING_ID = 'wx';
export const SI_LINK_SENDING_ID = 'si-link';
export const SI_UNLINK_SENDING_ID = 'si-unlink';
export const SI_IMPORT_SENDING_ID = 'si-import';
export const SI_PUSH_SENDING_ID = 'si-push';

export interface SendToolbarProps {
  canned: CannedAcarsMessage[];
  cannedError: string;
  sendingId: string | null;
  plannedLegId: number | null;
  plannedLeg: PlannedLegWithChildren | null;
  wxIcao: string;
  onWxIcaoChange: (v: string) => void;
  siKeySet: boolean | null;
  hasPdcUplink: boolean;
  sendError: string;
  siMessage: string;
  onSend: (cannedId: string) => void;
  onLoadsheet: () => void;
  onClearance: () => void;
  onPush: () => void;
  onWx: () => void;
}

/** A button that shows an InlineLoading in place of its label while its own request is in flight. */
function ActionButton(props: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Button kind="ghost" size="md" disabled={props.disabled} title={props.title} onClick={props.onClick}>
      {props.busy ? <InlineLoading description={props.busyLabel} /> : props.label}
    </Button>
  );
}

export function SendToolbar(p: SendToolbarProps) {
  const idle = p.sendingId === null;
  const noLeg = p.plannedLegId === null;
  const noLegTitle = noLeg ? 'No planned leg linked to this flight' : undefined;

  const pushEnabled = !!p.siKeySet && !noLeg && p.hasPdcUplink && idle;
  let pushReason: string | undefined;
  if (!p.siKeySet) pushReason = 'No SayIntentions key saved (save it in Settings)';
  else if (noLeg) pushReason = 'No planned leg linked to this flight';
  else if (!p.hasPdcUplink) pushReason = 'No PDC clearance to send yet';

  const leg = p.plannedLeg;
  return (
    <Tile>
      <h2 className="sabia-heading-03 acars-section-title">Send</h2>
      {p.cannedError ? (
        <InlineNotification kind="error" role="alert" lowContrast hideCloseButton title={p.cannedError} />
      ) : (
        <div className="acars-toolbar">
          {p.canned.map(m => (
            <ActionButton
              key={m.id} label={m.label} busyLabel="Sending…" busy={p.sendingId === m.id}
              disabled={!idle} onClick={() => p.onSend(m.id)}
            />
          ))}
          <ActionButton
            label="REQUEST LOADSHEET" busyLabel="Requesting…" busy={p.sendingId === LOADSHEET_SENDING_ID}
            disabled={noLeg || !idle} title={noLegTitle} onClick={p.onLoadsheet}
          />
          <ActionButton
            label="REQUEST CLEARANCE" busyLabel="Requesting…" busy={p.sendingId === CLEARANCE_SENDING_ID}
            disabled={noLeg || !idle} title={noLegTitle} onClick={p.onClearance}
          />
          <ActionButton
            label="SEND TO SAYINTENTIONS" busyLabel="Sending…" busy={p.sendingId === SI_PUSH_SENDING_ID}
            disabled={!pushEnabled} title={pushEnabled ? undefined : pushReason} onClick={p.onPush}
          />
          <TextInput
            id="acars-wx-icao" labelText="ICAO" hideLabel placeholder="ICAO" size="md"
            value={p.wxIcao} disabled={!idle} onChange={e => p.onWxIcaoChange(e.target.value)}
          />
          {leg?.departure_is_airport ? (
            <Button kind="ghost" size="md" disabled={!idle} onClick={() => p.onWxIcaoChange(leg.departure_ident)}>
              {leg.departure_ident}
            </Button>
          ) : null}
          {leg?.destination_is_airport ? (
            <Button kind="ghost" size="md" disabled={!idle} onClick={() => p.onWxIcaoChange(leg.destination_ident)}>
              {leg.destination_ident}
            </Button>
          ) : null}
          <ActionButton
            label="REQUEST WX" busyLabel="Requesting…" busy={p.sendingId === WX_SENDING_ID}
            disabled={!idle || !isPlausibleIcao(p.wxIcao)} onClick={p.onWx}
          />
        </div>
      )}
      {p.sendError && (
        <InlineNotification kind="error" role="alert" lowContrast hideCloseButton title={p.sendError} style={{ marginTop: '0.75rem' }} />
      )}
      {p.siKeySet === false && (
        <p className="acars-status">
          SEND TO SAYINTENTIONS needs an API key: save it in <Link as={RouterLink} to="/settings">Settings</Link>.
        </p>
      )}
      {p.siMessage && <p className="acars-status">{p.siMessage}</p>}
    </Tile>
  );
}
