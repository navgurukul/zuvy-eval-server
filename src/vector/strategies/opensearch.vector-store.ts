import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  IVectorStore,
  VectorPoint,
  VectorPayload,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';

/** An OpenSearch client error, which carries the HTTP status on itself or meta. */
type OpenSearchError = { statusCode?: number; meta?: { statusCode?: number } };

/**
 * Amazon OpenSearch Serverless (NextGen, vector search) implementation.
 *
 * Differences from Qdrant that callers should be aware of:
 *  - Index names must be lowercase, so collection names are lowercased.
 *  - Vectors are not returned in _source; search works, but you cannot read
 *    an embedding back out the way Qdrant's with_vectors=true allows.
 *  - Writes are not immediately visible. There is no refresh API on
 *    serverless; expect a few seconds before a new document is searchable.
 *  - Payload field types come from the index mapping, not from calls to
 *    createPayloadIndex, which is a no-op here.
 *  - The index and its mapping are owned by the migration tooling.
 *    ensureCollection only verifies existence; it never creates an index.
 */
@Injectable()
export class OpenSearchVectorStore implements IVectorStore {
  private readonly logger = new Logger(OpenSearchVectorStore.name);
  private readonly client: Client;
  private readonly region: string;
  private readonly normalizeScores: boolean;

  constructor(private readonly config: ConfigService) {
    const host = (
      this.config.get<string>('OPENSEARCH_HOST') ||
      process.env.OPENSEARCH_HOST ||
      ''
    )
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    if (!host) {
      throw new Error('OPENSEARCH_HOST is not set');
    }

    this.region =
      this.config.get<string>('AWS_REGION') || process.env.AWS_REGION || 'ap-south-1';

    // Default true so scores are comparable to Qdrant's cosine values.
    this.normalizeScores =
      (this.config.get<string>('OPENSEARCH_NORMALIZE_SCORES') ??
        process.env.OPENSEARCH_NORMALIZE_SCORES ??
        'true') !== 'false';

    this.client = new Client({
      ...AwsSigv4Signer({
        region: this.region,
        service: 'aoss', // 'es' for a provisioned domain
        getCredentials: () => defaultProvider()(),
      }),
      node: `https://${host}`,
      requestTimeout: 60000,
      maxRetries: 3,
    });

    this.logger.log(`OpenSearchVectorStore initialized with host=${host}`);
  }

  /** OpenSearch client errors carry the HTTP status on the error or its meta. */
  private statusCodeOf(error: unknown): number | undefined {
    const e = error as OpenSearchError | null;
    return e?.statusCode ?? e?.meta?.statusCode;
  }

  /** OpenSearch index names must be lowercase; "QUESTIONS" -> "questions". */
  private indexName(collectionName: string): string {
    return collectionName.toLowerCase();
  }

  /**
   * OpenSearch returns 1 / (1 + distance) for cosinesimil, where
   * distance = 1 - cosine. Inverting gives back the cosine value, so existing
   * Qdrant score thresholds keep roughly the same meaning.
   */
  private toCosine(score: number): number {
    if (!this.normalizeScores) return score;
    if (!score || score <= 0) return 0;
    return 2 - 1 / score;
  }

  /**
   * Verifies that the index exists. It deliberately never creates one: the
   * mapping (knn_vector dimension, keyword payload fields, dynamic: strict)
   * is owned by the migration tooling, and an index auto-created here would
   * get a different, silently wrong mapping. A missing index is therefore a
   * deployment error and is surfaced as one.
   */
  async ensureCollection(collectionName: string, vectorSize: number): Promise<void> {
    const index = this.indexName(collectionName);

    let exists: boolean;
    try {
      const response = await this.client.indices.exists({ index });
      exists = response.body === true || response.statusCode === 200;
    } catch (error) {
      if (this.statusCodeOf(error) === 404) {
        exists = false;
      } else {
        this.logger.error(`Error checking index ${index}:`, error);
        throw error;
      }
    }

    if (exists) return;

    const message =
      `OpenSearch index "${index}" does not exist, and this class does not ` +
      `create it. Its mapping (embedding as knn_vector dimension ${vectorSize}, ` +
      `keyword payload fields, dynamic: strict) is owned by the migration ` +
      `tooling; create the index there before starting the app.`;
    this.logger.error(message);
    throw new Error(message);
  }

  async upsert(collectionName: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const index = this.indexName(collectionName);

    // Indexing by _id overwrites, which matches Qdrant upsert semantics.
    const operations = points.flatMap((p) => [
      { index: { _index: index, _id: String(p.id) } },
      // Payload spread first so a payload key named "embedding" cannot
      // overwrite the actual vector.
      { ...(p.payload ?? {}), embedding: p.vector },
    ]);

    const { body } = await this.client.bulk({ body: operations });

    if (body.errors) {
      const failed = body.items
        .filter((i: any) => i.index?.error)
        .map((i: any) => ({ id: i.index._id, error: i.index.error }));
      this.logger.error(
        `Bulk upsert: ${failed.length}/${points.length} failed. First: ` +
          JSON.stringify(failed[0]),
      );
      // The migration-owned mapping sets dynamic: strict (this class neither
      // sets it nor creates the index), so a payload field absent from that
      // mapping is rejected rather than silently guessed. Surface it.
      throw new Error(
        `OpenSearch bulk upsert failed for ${failed.length} documents: ` +
          JSON.stringify(failed[0]?.error),
      );
    }

    this.logger.debug(`Upserted ${points.length} points into ${index}`);
  }

  async search(
    collectionName: string,
    queryVector: number[],
    options?: { limit?: number; filter?: VectorPayload },
  ): Promise<VectorSearchResult[]> {
    const index = this.indexName(collectionName);
    const limit = options?.limit ?? 10;

    const must: any[] = [];
    const mustNot: any[] = [];

    for (const [key, value] of Object.entries(options?.filter ?? {})) {
      if (value === null || value === undefined) {
        // OpenSearch has no "match null"; the equivalent is must_not exists,
        // which also covers a field stored explicitly as null. Qdrant differs
        // here - its match.value accepts only string/integer/bool and it has a
        // separate is_null condition - so a null filter value is one of the
        // cases where the two stores do not behave identically.
        mustNot.push({ exists: { field: key } });
      } else if (Array.isArray(value)) {
        must.push({ terms: { [key]: value } });
      } else {
        must.push({ term: { [key]: value } });
      }
    }

    const knn: any = { vector: queryVector, k: limit };
    if (must.length || mustNot.length) {
      knn.filter = { bool: { ...(must.length && { must }), ...(mustNot.length && { must_not: mustNot }) } };
    }

    const { body } = await this.client.search({
      index,
      body: { size: limit, query: { knn: { embedding: knn } } },
    });

    return body.hits.hits.map((hit: any) => {
      const { embedding, ...payload } = hit._source ?? {};
      return {
        id: String(hit._id),
        score: this.toCosine(hit._score ?? 0),
        payload: Object.keys(payload).length ? (payload as VectorPayload) : undefined,
      };
    });
  }

  async delete(collectionName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.indexName(collectionName);

    const operations = ids.map((id) => ({ delete: { _index: index, _id: String(id) } }));
    const { body } = await this.client.bulk({ body: operations });

    if (body.errors) {
      // A 404 on delete means it was already gone, which is not an error here.
      const failed = body.items.filter(
        (i: any) => i.delete?.error && i.delete.status !== 404,
      );
      if (failed.length) {
        this.logger.error(
          `Bulk delete: ${failed.length} failed. First: ${JSON.stringify(failed[0])}`,
        );
      }
    }

    this.logger.debug(`Deleted ${ids.length} points from ${index}`);
  }

  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: 'keyword' | 'integer' | 'float' | 'bool',
  ): Promise<void> {
    // No equivalent in OpenSearch: every mapped field is indexed for filtering
    // already, and the index is dynamic:strict so field types are fixed at
    // creation time. Kept as a no-op so callers need no branching.
    this.logger.debug(
      `createPayloadIndex is a no-op on OpenSearch ` +
        `(${collectionName}.${fieldName} as ${fieldSchema}); ` +
        `field types come from the index mapping.`,
    );
  }
}