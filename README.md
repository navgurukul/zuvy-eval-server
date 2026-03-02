# Zuvy Evaluation Server

<p align="center">
  <img src="public/zuvyfaviconLight.ico" alt="Zuvy Light Icon" width="64" />
  <img src="public/zuvyfavicondark.ico" alt="Zuvy Dark Icon" width="64" />
</p>

Backend for **question generation** (LLM) and **live exam / assessment** flows. Built with NestJS, Postgres (Drizzle ORM), BullMQ, and Qdrant.

## What it does

- **Question generation**  
  Instructors trigger generation with a payload (domain, topic, Bloom’s level, difficulty, etc.). Jobs are enqueued (BullMQ); each job calls the LLM, parses MCQs, and saves them into the question pool (`main.zuvy_questions`). The UI is not blocked.

- **AI assessments**  
  Assessments can be created and assigned to students. MCQs are generated per level (or pulled from a vector store). Students submit answers; the system scores, assigns levels, and can evaluate with the LLM.

- **Vector store (pluggable)**  
  Strategy interface for Qdrant (default) or Pinecone. Used to store question embeddings and run semantic search when building assessments from the pool.

## Tech stack

- **Runtime**: Node.js, NestJS  
- **Database**: Postgres, Drizzle ORM  
- **Queue**: BullMQ (Redis)  
- **LLM**: OpenAI, Google GenAI (pluggable via `LlmService`)  
- **Vector DB**: Qdrant (default), swappable

## Project layout (main areas)

- `src/questions` – Question generation API, job expansion (topics × batches of 10), processor (LLM → parse → save to `zuvy_questions`), schema + SQL for `main.zuvy_questions`.
- `src/ai-assessment` – Assessment CRUD, level-based MCQ generation, submit/evaluate, prompts.
- `src/vector` – `IVectorStore` + Qdrant/Pinecone strategies, controller for collection/upsert/search.
- `src/llm` – `LlmService`, providers, `mcqParser` / `evaluationParser`.
- `src/db/schema` – Drizzle schemas (assessments, levels, questions_by_llm, etc.).

## Setup

```bash
npm install
```

Environment: `DB_*`, `REDIS_HOST`, `REDIS_PORT`, `OPENAI_KEY` or `GOOGLE_GENAI_API_KEY`, `QDRANT_URL` (optional). Create `main.zuvy_questions` using `src/questions/schema/zuvy-questions.sql` if needed.

## Run

```bash
npm run start:dev
```

## Key endpoints

- **Questions**: `POST /questions/generate` – enqueue generation jobs (body: domain, topic, counts, etc.).
- **Assessments**: `POST /ai-assessment`, `POST /ai-assessment/generate/all`, `POST /ai-assessment/submit`.
- **Vector**: `POST /vector/collection`, `POST /vector/upsert`, `POST /vector/search`.

## License

AGPL-3.0 license.
