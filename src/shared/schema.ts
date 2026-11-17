/** Consent level of the visitor when the event was recorded. */
export type Consent = "basic" | "full";

/** Where a row was produced. */
export type Via = "client" | "server" | "proxy";

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

export type PropValue = string | number | boolean | null;
export type Props = Record<string, PropValue>;

/** One event as the browser tracker sends it to the collector. */
export interface ClientEvent {
  event: string;
  ts?: number;
  path: string;
  title?: string;
  referrer?: string;
  utm?: Utm;
  props?: Props;
  consent: Consent;
  visitor_id?: string;
  session_id?: string;
  user_id?: string;
}

export interface ClientBatch {
  site: string;
  events: ClientEvent[];
}

/** One row of the BigQuery `events` table. Keep in sync with sql/01_events.sql. */
export interface EventRow {
  ts: string;
  site: string;
  event: string;
  via: Via;
  visitor_hash: string | null;
  visitor_id: string | null;
  session_id: string | null;
  user_id: string | null;
  consent: Consent | null;
  host: string | null;
  path: string | null;
  title: string | null;
  referrer_host: string | null;
  channel: string | null;
  source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  country: string | null;
  region: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  is_bot: boolean;
  bot_name: string | null;
  bot_kind: string | null;
  user_agent: string | null;
  props: string | null;
}

export const LIMITS = {
  bodyBytes: 8192,
  eventsPerBatch: 25,
  eventName: /^[a-zA-Z0-9_.:-]{1,64}$/,
  site: /^[a-zA-Z0-9_.-]{1,64}$/,
  id: /^[a-zA-Z0-9_.:@-]{1,128}$/,
  pathLength: 512,
  titleLength: 200,
  utmLength: 150,
  propKeys: 20,
  propKey: /^[a-zA-Z0-9_]{1,40}$/,
  propStringLength: 200,
} as const;
