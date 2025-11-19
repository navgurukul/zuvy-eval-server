ARG NODE_VERSION=20.18.0

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV TZ=UTC

FROM base AS deps
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package*.json ./
RUN npm ci

FROM deps AS build
ENV NODE_ENV=development
COPY . .
RUN npm run build

FROM base AS prod-deps
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 5000
CMD ["node", "dist/main"]
