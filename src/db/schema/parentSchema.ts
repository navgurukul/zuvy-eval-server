import { bigserial, integer, pgSchema, serial, unique, varchar } from "drizzle-orm/pg-core";

export const main = pgSchema("main");

export const zuvyBootcamps = main.table("zuvy_bootcamps", {
  id: varchar("id").primaryKey(),
});

export const users = main.table("users", {
  id: varchar("id").primaryKey(),
  email: varchar("email", { length: 50 }),
});

export const zuvyBatchEnrollments = main.table('zuvy_batch_enrollments', {
  id: serial('id').primaryKey().notNull(),
  userId: bigserial('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade'
    }),
  bootcampId: integer('bootcamp_id').references(() => zuvyBootcamps.id, {
    onDelete: 'cascade',
    onUpdate: 'cascade'
  }),
});

  export const userTokens = main.table(
    'user_tokens',
    {
      id: serial('id').primaryKey().notNull(),
      userId: integer('user_id')
        .notNull()
        .references(() => users.id),
      userEmail: varchar('user_email', { length: 255 })
        .notNull()
        .references(() => users.email),
      accessToken: varchar('access_token', { length: 300 }).notNull(),
      refreshToken: varchar('refresh_token', { length: 300 }).notNull(),
    },
    (table) => {
      return {
        mainUserTokensUserIdUnique: unique('main_user_tokens_user_id_unique').on(table.userId)
      };
    },
  );

  export const blacklistedTokens = main.table('blacklisted_tokens', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey().notNull(),
  });

  export const zuvyUserRoles = main.table('zuvy_user_roles', {
  id: serial('id').primaryKey().notNull(),
  });

  export const zuvyUserRolesAssigned = main.table('zuvy_user_roles_assigned', {
    id: serial('id').primaryKey().notNull(),
  });

  export const sansaarUserRoles = main.table( 'sansaar_user_roles', {
    id: serial('id').primaryKey().notNull(),
  });