import { QuestionsCrudService } from './questions.crud.service';

/**
 * A question that is stored but never embedded is invisible to everything that
 * reads the search index: assessment mapping cannot select it, and the
 * duplicate checks cannot see it, so generation is free to write it again.
 *
 * Two paths used to leave the index behind. Creating a question by hand wrote
 * no outbox row at all, and editing one wrote none either, so the stored vector
 * went on describing wording that had been rewritten.
 */

type OutboxRow = { questionId: number; status: string };

function buildService(existing: Record<string, unknown> | null = { id: 7 }) {
  const outbox: OutboxRow[] = [];

  const tx = {
    insert: () => ({
      values: (value: OutboxRow) => {
        // The question insert returns a row; the outbox insert is recorded.
        if (value && typeof value.questionId === 'number') {
          outbox.push(value);
          return Promise.resolve(undefined);
        }
        return { returning: () => Promise.resolve([{ id: 7 }]) };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(existing ? [existing] : []),
        }),
      }),
    }),
  };

  const db = {
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return {
    service: new QuestionsCrudService(db as never),
    outbox,
  };
}

const NEW_QUESTION = {
  topicName: 'Arrays',
  topicDescription: 'indexing and traversal',
  question: 'wug lorp blint',
  options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' },
  correctOption: 1,
} as never;

describe('creating a question by hand', () => {
  it('queues it for indexing, as generation does', async () => {
    const { service, outbox } = buildService();

    await service.create(1, NEW_QUESTION);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ questionId: 7, status: 'pending' });
  });
});

describe('editing a question', () => {
  const edit = (patch: Record<string, unknown>) => patch as never;

  it('re-indexes when the wording changes', async () => {
    const { service, outbox } = buildService();
    await service.update(1, 7, edit({ question: 'reworded entirely' }));
    expect(outbox).toHaveLength(1);
  });

  it('re-indexes when the topic or difficulty changes', async () => {
    for (const patch of [
      { topicName: 'Loops' },
      { topicDescription: 'new description' },
      { subtopics: ['recursion'] },
      { difficulty: 'hard' },
    ]) {
      const { service, outbox } = buildService();
      await service.update(1, 7, edit(patch));
      expect(outbox).toHaveLength(1);
    }
  });

  it('does not re-index for a change the index cannot see', async () => {
    // Options and the correct answer are not part of the embedded text, so
    // fixing a wrong answer costs no embedding call.
    for (const patch of [
      { correctOption: 3 },
      { options: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' } },
      { levelId: 'B' },
      { language: 'hi' },
    ]) {
      const { service, outbox } = buildService();
      await service.update(1, 7, edit(patch));
      expect(outbox).toHaveLength(0);
    }
  });

  it('queues nothing when the question does not exist', async () => {
    const { service, outbox } = buildService(null);
    await expect(service.update(1, 7, edit({ question: 'x' }))).rejects.toThrow(
      /not found/i,
    );
    expect(outbox).toHaveLength(0);
  });
});
