/**
 * Payload stored with a vector (e.g. questionId, levelId for questions).
 * All values should be JSON-serializable.
 */
export type VectorPayload = Record<string, string | number | boolean | null>;

/**
 * Single point: id, embedding vector, and optional metadata.
 */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: VectorPayload;
}

/**
 * Result item from a similarity search.
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  payload?: VectorPayload;
}

/**
 * Strategy interface for any vector DB (Qdrant, Pinecone, etc.).
 * Implement this to swap providers without changing callers.
 */
export interface IVectorStore {
  /**
   * Create collection if it does not exist. Vector size must match embedding dimension.
   */
  ensureCollection(collectionName: string, vectorSize: number): Promise<void>;

  /**
   * Upsert points (add or overwrite by id).
   */
  upsert(collectionName: string, points: VectorPoint[]): Promise<void>;

  /**
   * Similarity search: return nearest vectors to the query vector.
   */
  search(
    collectionName: string,
    queryVector: number[],
    options?: { limit?: number; filter?: VectorPayload },
  ): Promise<VectorSearchResult[]>;

  /**
   * Delete points by id.
   */
  delete(collectionName: string, ids: string[]): Promise<void>;
}
