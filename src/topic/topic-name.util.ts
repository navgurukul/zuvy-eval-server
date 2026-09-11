import { SQL, sql } from 'drizzle-orm';

/** Trim and collapse inner whitespace so "REST  APIs" matches "REST APIs". */
export function normalizeTopicName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}

export function topicNameKey(name: string | null | undefined): string {
  return normalizeTopicName(name).toLowerCase();
}

/** Case-insensitive, trimmed match of a topic-name column against a request string. */
export function topicNameEquals(column: unknown, topicName: string): SQL {
  return sql`LOWER(TRIM(${column})) = ${topicNameKey(topicName)}`;
}

/** Case-insensitive, trimmed match between two topic-name columns. */
export function topicNamesMatch(left: unknown, right: unknown): SQL {
  return sql`LOWER(TRIM(${left})) = LOWER(TRIM(${right}))`;
}
